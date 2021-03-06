
require('dotenv').config();
const axios = require('axios');
const randomId = require('nanoid').nanoid;

const LOBBY_LIMIT = 5;
const io = require('socket.io')(8000, {cors: true});
const redis = require('socket.io-redis');
const Ior = require('ioredis');
const ioredis = new Ior({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD
});
io.adapter(redis({
  host: process.env.REDIS_HOST, 
  port: process.env.REDIS_PORT,
  auth_pass: process.env.REDIS_PASSWORD
}));

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
    //await ioredis.del(lobbyCode); //DEV
    const rooms = await io.of('/').adapter.allRooms();
    const members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
    let gameInProgress = await ioredis.get(lobbyCode);

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
      const {data: prompt} = await axios({
        method: 'get',
        url: `http://${process.env.EXPRESS_HOST}:8000/prompt`
      });

      let lobbyObj = {};
      lobbyObj.placement = 0;

      let userArr = [];
      const members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
      for (let it = members.values(), socketID = null; socketID = it.next().value;) { // iterate through a SET
        const str = await ioredis.get(socketID);
        const {username} = JSON.parse(str);
        let newObj = {
          playerName: username,
          percentage: 0,
          placement: null,
          wpm: 0
        };
        userArr.push(newObj);
      }

      lobbyObj.users = userArr;
      let lobbyStr = JSON.stringify(lobbyObj);
      await ioredis.set(lobbyCode, lobbyStr); // used to disallows users to join lobby while race in progress and count player standings
      
      io.to(lobbyCode).emit('raceInit', {prompt: prompt});
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
  socket.on('letterTyped', async ({lobbyCode, percentage, wpm}) =>{ 
    const obj = await ioredis.get(socket.id);
    const {username: playerName} = JSON.parse(obj);
    if (percentage == 100) {
      let tempObj = await ioredis.get(lobbyCode)
      let {placement: pl, users} = JSON.parse(tempObj);

      for (let i = 0; i < users.length; i++) {
        if(users[i].playerName == playerName){
          users[i].percentage = percentage;
          users[i].placement = ++pl;
          users[i].wpm = wpm;
        }
      }
      io.to(lobbyCode).emit('updateText', {
        users: users
      });

      const members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
      if(members.size == pl){
        await ioredis.del(lobbyCode);
        updateLobby(lobbyCode);
      } else {
        let lobbyObj = {
          placement: pl,
          users: users
        };

        let lobbyStr = JSON.stringify(lobbyObj);
        await ioredis.set(lobbyCode, lobbyStr); 
      }
    } else {
        let {placement, users} = JSON.parse(await ioredis.get(lobbyCode));

        for (let i = 0; i < users.length; i++) {
          if(users[i].playerName == playerName){
            users[i].percentage = percentage;
            users[i].wpm = wpm;
          }
        }
        io.to(lobbyCode).emit('updateText', {
          users: users
        });
        let ioObj = {
          placement: placement,
          users: users
        };
        let ioStr = JSON.stringify(ioObj); 
        await ioredis.set(lobbyCode, ioStr);
    }
  });

  /* DISCONNECTING HANDLER - CALLED AUTOMATICALLY
    Similar logic to the leaveLobby handler - except we dont have access to any data via parameters.
    If a temporary User Object is found, we will delete it from both Redis and our SQL database.
  */
  socket.on('disconnecting', async (reason) =>{
    const user = await ioredis.get(socket.id);
    if (user != null) {
      const {lobbyCode, leader, username} = JSON.parse(user);
      if(lobbyCode != null){
          const members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
        if (leader && members.size >= 1) {
          const ids = members.values();
          let newLeader = null;
          while (newLeader == null || newLeader == socket.id) {
            newLeader = ids.next().value;
            console.log(newLeader);
          }

          let str = await ioredis.get(newLeader);
          let obj = JSON.parse(str);
          obj.leader = true;
          str = JSON.stringify(obj);
          await ioredis.set(newLeader, str);
        }

        const status = await ioredis.get(lobbyCode);
        if (status != null) { // implies that game is in progress
          let {placement: pl} = JSON.parse(status);
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
      try{
        await axios.delete(`http://${process.env.EXPRESS_HOST}:8000/deleteUser`, { data: { Username: username } });
      } catch (err) {
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`User ${socket.id} has disconnected`);
  });
});

console.log('app running');
