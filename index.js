
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

//

io.adapter(redis({host: process.env.REDIS_HOST, port: 6379}));
const randomId = require('nanoid').nanoid;

//Returns the status of the lobby
async function updateLobby(lobbyCode) {
  const members = await io.of('/').adapter.sockets(new Set([lobbyCode])); // socket-id members
  // console.log(members);
  const users = [];
  for (let it = members.values(), socketID = null; socketID = it.next().value;) { // iterate through a SET
    const str = await ioredis.get(socketID);
    const obj = JSON.parse(str);
    users.push(obj);
  }

  // console.log(users);
  io.to(lobbyCode).emit('lobbyUpdate', {
    users: users,
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

io.on('connection', async (socket) => {
  console.log(`User ${socket.id} has connected`);

  socket.leave(socket.id); // to leave the default room

  socket.on('createLobby', async ({username}) =>{
    const rooms = await io.of('/').adapter.allRooms();
    let lobbyCode;
    // do{
    //     lobbyCode = randomId(6);
    // } while(rooms.has(lobbyCode));
    lobbyCode = 'arceux';

    socket.join(lobbyCode);

    const json = JSON.stringify({username: username, ready: false, leader: true, lobby: lobbyCode});
    await ioredis.set(socket.id, json);

    socket.emit('createLobbyResponse', {
      lobbyCode: lobbyCode,
    });
  });

  socket.on('joinLobby', async ({lobbyCode, username}) =>{
    await ioredis.del(lobbyCode); // COMMENT FOR PRODUCTION
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
      const json = JSON.stringify({username: username, ready: false, leader: false, lobby: lobbyCode});
      await ioredis.set(socket.id, json);

      await updateLobby(lobbyCode);
    }
  });

  socket.on('leaveLobby', async ({lobbyCode})=>{
    // console.log("HIT");
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

        const transferPower = await ioredis.get(newLeader);
        const obj = JSON.parse(transferPower);
        obj.leader = true;
        const newObj = JSON.stringify(obj);
        await ioredis.set(newLeader, newObj);
      }
      socket.leave(lobbyCode);
      await ioredis.del(socket.id);

      await updateLobby(lobbyCode);
    } else {
      socket.emit('lobbyUpdate', {error: 'You are not a member of this lobby'});
    }
  });

  socket.on('toggleReady', async ({lobbyCode}) =>{
    const userObj = await ioredis.get(socket.id);
    const obj = JSON.parse(userObj);
    obj.ready = !obj.ready;
    const str = JSON.stringify(obj);
    await ioredis.set(socket.id, str);

    await updateLobby(lobbyCode);
  });

  socket.on('kickPlayer', async ({lobbyCode, playerName})=>{
    const userObj = await ioredis.get(socket.id);
    const {leader} = JSON.parse(userObj);
    const userID = await searchForUser(lobbyCode, playerName);
    if (leader && userID != null) {
      await io.of('/').adapter.remoteLeave(userID, lobbyCode);
      await ioredis.del(userID);
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
    } else {
      io.to(lobbyCode).emit('raceInit', {error: 'Not everyone is ready to start the race.'});
    }
  });

  socket.on('letterTyped', async ({lobbyCode, percentage}) =>{ // WPM
    const obj = await ioredis.get(socket.id);
    const {username: playerName} = JSON.parse(obj);
    if (percentage == 3) {
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

  socket.on('returnLobby', async ({lobbyCode})=>{
    const pipeline = ioredis.pipeline();
    const members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
    for (let it = members.values(), socketID = null; socketID = it.next().value;) { // iterate through a SET
      const user = await ioredis.get(socketID);
      const obj = JSON.parse(user);
      obj.ready = false;
      const str = JSON.stringify(obj);
      pipeline.set(socketID, str);
    }

    pipeline.del(lobbyCode);
    pipeline.exec(); // batch write

    updateLobby(lobbyCode);
  });

  socket.on('disconnecting', async (reason) =>{
    const user = await ioredis.get(socket.id);
    if (user != null) {
      const {lobby: lobbyCode, leader} = JSON.parse(user);
      const members = await io.of('/').adapter.sockets(new Set([lobbyCode]));

      if (leader && members.size > 1) {
        const ids = members.values();
        let newLeader = null;
        while (newLeader == null || newLeader == socket.id) {
          newLeader = ids.next().value;
        }

        const transferPower = await ioredis.get(newLeader);
        const obj = JSON.parse(transferPower);
        obj.leader = true;
        const newObj = JSON.stringify(obj);
        await ioredis.set(newLeader, newObj);
      }
      await ioredis.del(socket.id);
      const status = await ioredis.get(lobbyCode);
      if (status != null) { // implies that game is in progress
        socket.to(lobbyCode).emit('updateText', {error: 'User has disconnected'} );
      } else {
        await updateLobby(lobbyCode);
      }
      const theOne = await User.findOne({where: {username: user}});
      if (theOne != null) {
        await User.destroy({where: {username: user}});
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`User ${socket.id} has disconnected`);
  });
});

console.log('app running');
