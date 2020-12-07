
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
const ioredis = new Ior(6379, process.env.REDIS_HOST);

io.adapter(redis({host: process.env.REDIS_HOST, port: 6379}));
const randomId = require('nanoid').nanoid;

//Returns the status of the lobby
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

//checks if all members of the lobby are ready
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

//looks for a user within the lobby
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

//change user properties
async function changeProperties(socketID, lobbyCode, ready, leader, toggle){
  let jsonStr = await ioredis.get(socketID);
  let json = JSON.parse(jsonStr);

  if(leader != null){
    json.leader = leader;
  }   
  if(ready != null){
    json.ready = ready;
  }
  if(toggle){
    json.ready = !json.ready;
  }
  if(json.lobbyCode != lobbyCode){
    json.lobbyCode = lobbyCode;
  }

  jsonStr = JSON.stringify(json);
  await ioredis.set(socketID, json);
}

io.on('connection', async (socket) => {
  console.log(`User ${socket.id} has connected`);

  socket.leave(socket.id); // to leave the default room

  socket.on('newUser', async ({username})=>{
    const json = JSON.stringify({username: username, ready: false, leader: false, lobbyCode: null});
    await ioredis.set(socket.id, json);
  });

  socket.on('createLobby', async ({}) =>{
    const rooms = await io.of('/').adapter.allRooms();
    let lobbyCode;
    do{
        lobbyCode = randomId(6);
    } while(rooms.has(lobbyCode));
    //lobbyCode = 'arceux';

    socket.join(lobbyCode);
    await changeProperties(socket.id, lobbyCode, false, true, false);
    await updateLobby(lobbyCode);
  });

  socket.on('joinLobby', async ({lobbyCode}) =>{
    //await ioredis.del(lobbyCode); // COMMENT FOR PRODUCTION
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
      await changeProperties(socket.id, lobbyCode, false, false, false);
      await updateLobby(lobbyCode);
    }
  });

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
        await changeProperties(newLeader, lobbyCode, null, true, false);
      }
      socket.leave(lobbyCode);
      await changeProperties(socket.id, null, false, false, false);
      await updateLobby(lobbyCode);
    } else {
      socket.emit('lobbyUpdate', {error: 'You are not a member of this lobby'});
    }
  });

  socket.on('toggleReady', async ({lobbyCode}) =>{
    await changeProperties(socket.id, lobbyCode, null, null, true);
    await updateLobby(lobbyCode);
  });

  socket.on('kickPlayer', async ({lobbyCode, playerName})=>{
    const userObj = await ioredis.get(socket.id);
    const {leader} = JSON.parse(userObj);
    const userID = await searchForUser(lobbyCode, playerName);
    if (leader && userID != null) {
      await io.of('/').adapter.remoteLeave(userID, lobbyCode);
      await changeProperties(userID, null, false, false, false);
      await updateLobby(lobbyCode);
    } else {
      socket.emit('lobbyUpdate', {error: `Unable to kick ${playerName} from the lobby`});
    }
  });

  socket.on('startGame', async ({lobbyCode}) =>{
    const flag = await readyCheck(lobbyCode);
    if (flag) {
      const {prompt} = await Prompt.findOne({order: sequelize.random()});
      await ioredis.set(lobbyCode, 0); // disallows users to join lobby while race in progress
      io.to(lobbyCode).emit('raceInit', {prompt: prompt});
      for (let it = members.values(), socketID = null; socketID = it.next().value;) { // iterate through a SET
        await changeProperties(socketID, lobbyCode, false, null, false);
      }
    } else {
      io.to(lobbyCode).emit('raceInit', {error: 'Not everyone is ready to start the race.'});
    }
  });

  socket.on('letterTyped', async ({lobbyCode, percentage}) =>{ 
    const obj = await ioredis.get(socket.id);
    const {username: playerName} = JSON.parse(obj);
    if (percentage == 100) {
      let pl = await ioredis.get(lobbyCode);
      io.to(lobbyCode).emit('updateText', {
        playerName: playerName,
        percentage: percentage,
        placement: ++pl,
      });

      await ioredis.set(lobbyCode, pl);
    } else {
      io.to(lobbyCode).emit('updateText', {
        playerName: playerName,
        percentage: percentage,
      });
    }
  });

  socket.on('disconnecting', async (reason) =>{
    const user = await ioredis.get(socket.id);
    if (user != null) {
      const {lobby: lobbyCode, leader, username} = JSON.parse(user);
      if(lobbyCode != null){
          const members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
        if (leader && members.size > 1) {
          const ids = members.values();
          let newLeader;
          do{
            newLeader = ids.next().value;
          } while (newLeader == socket.id);
          await changeProperties(newLeader, lobbyCode, null, true, false);
        }

        const status = await ioredis.get(lobbyCode);
        if (status != null) { // implies that game is in progress
          socket.to(lobbyCode).emit('updateText', {error: `User ${username} has disconnected`} );
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
