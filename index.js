
require('dotenv').config();
const {Sequelize} = require('sequelize');
const sequelize = new Sequelize('NameText', process.env.USER, process.env.PASSWORD, {
  host: process.env.DB_HOST,
  dialect: 'mysql',
  define: {
    timestamps: false,
  },
});
const Prompt = sequelize.define('prompts', {
  id: {
    type: Sequelize.INTEGER,
    allowNull: false,
    primaryKey: true,
  },
  prompt: {
    type: Sequelize.STRING,
    allowNull: false,
  },
  language: {
    type: Sequelize.STRING,
  },
});
const User = sequelize.define('users', {
  id: {
    type: Sequelize.INTEGER,
    allowNull: false,
    primaryKey: true,
  },
  username: {

    type: Sequelize.STRING,
    allowNull: false,
  },
});

const LOBBY_LIMIT = 7;
const io = require('socket.io')(8000, {cors: true});
const redis = require('socket.io-redis');
const Ior = require('ioredis');
const ioredis = new Ior(6379, process.env.REDIS_HOST);  //DEV
io.adapter(redis({host: process.env.REDIS_HOST, port: 6379}));
const randomId = require('nanoid').nanoid;

/*  LOBBYUPDATE
  RETURN: The latest state of the lobby
  EXAMPLE: { users: [userObj1, userObj2, userObj3...] } || {error: string}
    where userObj = { username: string, ready: bool, leader: bool, lobbyCode: string} 
*/
async function updateLobby(lobbyCode) {
  const members = await io.of('/').adapter.sockets(new Set([lobbyCode])); // socket-id members
  const users = [];
  for (let it = members.values(), socketID = null; socketID = it.next().value;) { // iterate through a SET
    const str = await ioredis.get(socketID);
    const obj = JSON.parse(str);
    users.push(obj);
  }

  io.to(lobbyCode).emit('lobbyUpdate', {
    users: users
  });
}

/* Helper Function
  RETURN: Boolean - Checks if all members of the lobby are ready
*/
async function readyCheck(lobbyCode) {
  const members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
  let readyCheck = true;
  for (let it = members.values(), socketID = null; socketID = it.next().value;) { // iterate through a SET
    const str = await ioredis.get(socketID);
    const obj = JSON.parse(str);
    if (!obj.ready) {
      readyCheck = false;
    }
  }
  return readyCheck;
}

/*
  RETURN: Boolean - Searches for a user within the lobby by playerName
*/
async function searchForUser(lobbyCode, playerName) {
  const members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
  for (let it = members.values(), socketID = null; socketID = it.next().value;) { // iterate through a SET
    const str = await ioredis.get(socketID);
    const {username} = JSON.parse(str);
    if (username == playerName) {
      return socketID;
    }
  }
  return null;
}

io.on('connection', async (socket) => {
  console.log(`User ${socket.id} has connected`);

  socket.leave(socket.id); // to leave the default room

  /* NEW_USER HANDLER
    Initialize user instance in the Redis Active User Hashmap  
  */
  socket.on('newUser', async ({username})=>{
    const json = JSON.stringify({username: username, ready: false, leader: false, lobbyCode: null});
    await ioredis.set(socket.id, json)
  });

  /* CREATE_LOBBY HANDLER
    Generates a random Lobby and joins caller to the lobby.
    Updates the caller's User Object.
    updateLobby helper func.
  */
  socket.on('createLobby', async ({}) =>{
    const rooms = await io.of('/').adapter.allRooms();
    let lobbyCode;
    do{
        lobbyCode = randomId(6);
    } while(rooms.has(lobbyCode));
    //lobbyCode = 'arceux';  //DEV

    socket.join(lobbyCode);
    let str = await ioredis.get(socket.id);
    let obj = JSON.parse(str);
    obj.ready = false;
    obj.leader = true;
    obj.lobbyCode = lobbyCode;
    str = JSON.stringify(obj);
    await ioredis.set(socket.id, str);

    await updateLobby(lobbyCode);
  });

  /* JOIN_LOBBY HANDLER
    Checks for certain join conditions, if all are met then caller is joined into the Lobby.
    Caller's user object is updated.
    updateLobby helper func.
  */
  socket.on('joinLobby', async ({lobbyCode}) =>{
    const rooms = await io.of('/').adapter.allRooms();
    const members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
    const gameInProgress = await ioredis.get(lobbyCode);

    if (!rooms.has(lobbyCode)) {
      socket.emit('lobbyUpdate', {error: 'The lobby does not exist.'});
    } else if (members.has(socket.id)) {
      socket.emit('lobbyUpdate', {error: 'You are already a member of this lobby.'});
    } else if (members.size > LOBBY_LIMIT) {
      socket.emit('lobbyUpdate', {error: 'The lobby is full.'});
    } else if (gameInProgress != null) {
      socket.emit('lobbyUpdate', {error: 'Game is in progress, please wait.'});
    } else {
      socket.join(lobbyCode);

      let str = await ioredis.get(socket.id);
      let obj = JSON.parse(str);
      obj.ready = false;
      obj.leader = false;
      obj.lobbyCode = lobbyCode;
      str = JSON.stringify(obj);
      await ioredis.set(socket.id, str);

      await updateLobby(lobbyCode);
    }
  });

  /* LEAVE_LOBBY HANDLER
    Checks for leave conditions and removes caller from the Lobby.
    Updates caller's user object.
    Takes care of transfers of power when the caller is also the leader of the lobby.
    updateLobby Helper func.
  */
  socket.on('leaveLobby', async ({lobbyCode})=>{
    const members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
    if (members.has(socket.id)) {
      const str = await ioredis.get(socket.id);
      const {leader} = JSON.parse(str);
      if (leader && members.size > 1) {
        const ids = members.values();
        let newLeader = null;
        while (newLeader == null || newLeader == socket.id) {
          newLeader = ids.next().value;
        }

        let str = await ioredis.get(newLeader);
        let obj = JSON.parse(str);
        obj.leader = true;
        str = JSON.stringify(obj);
        await ioredis.set(newLeader, str);
      }
      socket.leave(lobbyCode);

      let jsonStr = await ioredis.get(socket.id);
      let obj = JSON.parse(jsonStr);
      obj.ready = false;
      obj.leader = false;
      obj.lobbyCode = null;
      jsonStr = JSON.stringify(obj);
      await ioredis.set(socket.id, jsonStr);

      await updateLobby(lobbyCode);
    } else {
      socket.emit('lobbyUpdate', {error: 'You are not a member of this lobby'});
    }
  });

  /* TOGGLE_READY HANDLER
    Alters the caller's 'ready' property in their User Object.
    updateLobby helper func.
  */
  socket.on('toggleReady', async ({lobbyCode}) =>{
    let str = await ioredis.get(socket.id);
    let obj = JSON.parse(str);
    obj.ready = !obj.ready;
    str = JSON.stringify(obj);
    await ioredis.set(socket.id, str);
    await updateLobby(lobbyCode);
  });

  /* KICK_PLAYER HANDLER
    Checks for kick conditions, if met then the unwanted player will be forcefully removed from the socket channel.
    Sends a KICKED EVENT to the frontend for client side page navigation.
    Alters the kicked players User Object.
    updateLobby helper func.
  */
  socket.on('kickPlayer', async ({lobbyCode, playerName})=>{
    const userObj = await ioredis.get(socket.id);
    const {leader} = JSON.parse(userObj);
    const userID = await searchForUser(lobbyCode, playerName);
    if (leader && userID != null) {
      io.in(lobbyCode).emit('kicked', {playerName: playerName}); //KICKED EVENT - The player who will be removed from the lobby.
      await io.of('/').adapter.remoteLeave(userID, lobbyCode);

      let str = await ioredis.get(userID);
      let obj = JSON.parse(str);
      obj.ready = false;
      obj.leader = false;
      obj.lobbyCode = null;
      str = JSON.stringify(obj);
      await ioredis.set(userID, str);

      await updateLobby(lobbyCode);
    } else {
      socket.emit('lobbyUpdate', {error: `Unable to kick ${playerName} from the lobby`});
    }
  });

  /* START_GAME HANDLER
    readyCheck helper func, checks for start game conditons.
    If sucessful, database call is made to retrieve a RANDOM stringified code block.
    Updates the User Object's ready property to false for all players in the lobby.
    Sends a RACE_INIT event containing the code block data.
    EXAMPLE: { prompt: string } - the string is delimited via barlines | which represent new lines
  */
  socket.on('startGame', async ({lobbyCode}) =>{
    const flag = await readyCheck(lobbyCode);
    if (flag) {
      const {prompt} = await Prompt.findOne({order: sequelize.random()});
      await ioredis.set(lobbyCode, 0); // used to disallows users to join lobby while race in progress and count player standings
      io.to(lobbyCode).emit('raceInit', {prompt: prompt});
      const members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
      for (let it = members.values(), socketID = null; socketID = it.next().value;) { // iterate through a SET
        let str = await ioredis.get(socketID);
        let obj = JSON.parse(str);
        obj.ready = false;
        str = JSON.stringify(obj);
        await ioredis.set(socketID, str);
      }
    } else {
      io.to(lobbyCode).emit('raceInit', {error: 'Not everyone is ready to start the race.'});
    }
  });

  /* LETTER_TYPED HANDLER
    Relays typing progress from each player to the entire lobby.
    Checks for race completion and sends a final placement representing the Users standing.
    Deletes the lobby once all players have finished.
    Sends the UPDATE_TEXT EVENT.
    EXAMPLE: {playerName: string, percentage: int, placement: int}
  */
  socket.on('letterTyped', async ({lobbyCode, percentage}) =>{ 
    const obj = await ioredis.get(socket.id);
    const {username: playerName} = JSON.parse(obj);
    if (percentage >= 3) {
      let pl = await ioredis.get(lobbyCode);
      io.to(lobbyCode).emit('updateText', {
        playerName: playerName,
        percentage: percentage,
        placement: ++pl,
      });

      const members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
      if(members.size == pl){
        await ioredis.del(lobbyCode);
        updateLobby(lobbyCode);
      }
      else{
        await ioredis.set(lobbyCode, pl);
      }
    } else {
      io.to(lobbyCode).emit('updateText', {
        playerName: playerName,
        percentage: percentage,
      });
    }
  });

  /* DISCONNECTING HANDLER - CALLED AUTOMATICALLY
    Similar logic to the leaveLobby handler - except we dont have access to any data via parameters.
    If a temporary User Object is found, we will delete it from both Redis and our SQL database.
  */
  socket.on('disconnecting', async (reason) =>{
    const user = await ioredis.get(socket.id);
    console.log(user);
    if (user != null) {
      const {lobbyCode, leader, username} = JSON.parse(user);
      console.log(lobbyCode, leader, username);
      if(lobbyCode != null){
          const members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
        if (leader && members.size > 1) {
          const ids = members.values();
          let newLeader = null;
          while (newLeader == null || newLeader == socket.id) {
            newLeader = ids.next().value;
          }

          let str = await ioredis.get(newLeader);
          let obj = JSON.parse(str);
          obj.leader = true;
          str = JSON.stringify(obj);
          await ioredis.set(newLeader, str);
        }

        const status = await ioredis.get(lobbyCode);
        if (status != null) { // implies that game is in progress
          let pl = await ioredis.get(lobbyCode);
          const members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
          if(members.size == pl){
            await ioredis.del(lobbyCode);
            await updateLobby(lobbyCode);
          }else{
            socket.to(lobbyCode).emit('updateText', {error: `User ${username} has disconnected`} );
          }
        } else {
          await updateLobby(lobbyCode);
        } 
      }
      
      await ioredis.del(socket.id);
      const theOne = await User.findOne({where: {username: username}});
      if (theOne != null) {
        await User.destroy({where: {username: username}});
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`User ${socket.id} has disconnected`);
  });
});

console.log('app running');
