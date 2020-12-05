
require('dotenv').config();
const { Sequelize } = require('sequelize');
const sequelize = new Sequelize('NameText', process.env.USER , process.env.PASSWORD, {
    host: process.env.DB_HOST,
    dialect: 'mysql',
    define: {
        timestamps: false
    },
});
const Prompt = sequelize.define('prompts', {
    id:{
        type:Sequelize.INTEGER,
        allowNull:false,
        primaryKey:true
    },
    prompt:{
        type: Sequelize.STRING,
        allowNull: false,
    }
});
const LOBBY_LIMIT = 7;
const io = require('socket.io')(8000,{cors: true});
const redis = require('socket.io-redis');
const ior = require('ioredis');
const ioredis = new ior(6379, process.env.REDIS_HOST);

//

io.adapter(redis({host: process.env.REDIS_HOST, port: 6379}));
let randomId = require('nanoid').nanoid;


async function updateLobby(lobbyCode){
    let members = await io.of('/').adapter.sockets(new Set([lobbyCode])); //socket-id members
    //console.log(members);
    let users = [];
    for(let it = members.values(), socketID = null; socketID = it.next().value;) { //iterate through a SET
        let str = await ioredis.get(socketID);
        let obj = JSON.parse(str);
        users.push(obj);
    }
            
    //console.log(users);
    io.to(lobbyCode).emit('lobbyUpdate', {
        users: users
    });
}

async function readyCheck(lobbyCode){
    let members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
        let readyCheck = true;
        for(let it = members.values(), socketID = null; socketID = it.next().value;) { //iterate through a SET
            let str = await ioredis.get(socketID);
            let obj = JSON.parse(str);
            if(!obj.ready){
                readyCheck = false;
            }
        }
        return readyCheck;
}

async function searchForUser(lobbyCode, playerName){
    let members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
    for(let it = members.values(), socketID = null; socketID = it.next().value;) { //iterate through a SET
        let str = await ioredis.get(socketID);
        let {username} = JSON.parse(str);
        if(username == playerName){
            return socketID;
        }
    }
    return null;
}

io.on('connection', async (socket) => { 
    console.log(`User ${socket.id} has connected`);

    socket.leave(socket.id); //to leave the default room

    socket.on('createLobby', async ({username}) =>{
        let rooms = await io.of('/').adapter.allRooms();
        let lobbyCode;
        // do{
        //     lobbyCode = randomId(6);
        // } while(rooms.has(lobbyCode));
        lobbyCode = "arceux";

        socket.join(lobbyCode);

        let json = JSON.stringify({ username: username, ready: false, leader: true, lobby: lobbyCode });
        await ioredis.set(socket.id, json);

        socket.emit('createLobbyResponse', {
            lobbyCode : lobbyCode
        });
    });

    socket.on('joinLobby', async ({lobbyCode, username}) =>{
        await ioredis.del(lobbyCode); //COMMENT FOR PRODUCTION
        let rooms = await io.of('/').adapter.allRooms();
        let members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
        let gameInProgress = await ioredis.get(lobbyCode);
        //console.log(rooms.has(lobbyCode));
        //console.log(!members.has(socket.id));
        //console.log(members.size <= LOBBY_LIMIT);
        //console.log(gameInProgress == null);

        if(rooms.has(lobbyCode) && !members.has(socket.id) && members.size <= LOBBY_LIMIT && gameInProgress == null){
            socket.join(lobbyCode);
            let json = JSON.stringify({ username: username, ready: false, leader: false, lobby: lobbyCode });
            await ioredis.set(socket.id, json);

            await updateLobby(lobbyCode);
        }
        else{
            socket.emit('lobbyUpdate', { error: "Lobby cannot be joined."}); 
        }
    });

    socket.on('leaveLobby', async ({lobbyCode})=>{
        //console.log("HIT");
        let members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
        if(members.has(socket.id)){
            let str = await ioredis.get(socket.id);
            let {leader} = JSON.parse(str);
            if(leader && members.size > 1){
                let ids = members.values();
                let newLeader = null;
                while(newLeader == null || newLeader == socket.id){
                    newLeader = ids.next().value;
                }

                let transferPower = await ioredis.get(newLeader);
                let obj = JSON.parse(transferPower);
                obj.leader = true;
                let newObj = JSON.stringify(obj);
                await ioredis.set(newLeader, newObj);
            }
            socket.leave(lobbyCode);
            await ioredis.del(socket.id);
    
            await updateLobby(lobbyCode);
        }
        else{
            socket.emit('lobbyUpdate', {error: "You are not a member of this lobby"});
        }
    });

    socket.on('toggleReady', async({lobbyCode}) =>{
        let userObj = await ioredis.get(socket.id);
        let obj = JSON.parse(userObj);
        obj.ready = !obj.ready;
        let str = JSON.stringify(obj);
        await ioredis.set(socket.id, str);

        await updateLobby(lobbyCode);
    });

    socket.on('kickPlayer', async({lobbyCode, playerName})=>{
        let userObj = await ioredis.get(socket.id);
        let {leader} = JSON.parse(userObj);
        let userID = await searchForUser(lobbyCode,playerName);
        if(leader && userID != null){
            await io.of('/').adapter.remoteLeave(userID, lobbyCode);
            await updateLobby(lobbyCode);
        }
        else{
            socket.emit('lobbyUpdate', {error: `Unable to kick ${playerName} from the lobby`});
        }
    });

    socket.on('startGame', async ({lobbyCode}) =>{
        let flag = await readyCheck(lobbyCode);
        if(flag){
            let {prompt} = await Prompt.findOne({order:sequelize.random()});

            let members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
            await ioredis.set(lobbyCode, members.length); //disallows users to join lobby while race in progress
            
            io.to(lobbyCode).emit('raceInit', { prompt: prompt});
        }
        else{
            io.to(lobbyCode).emit('raceInit', { error: "Not everyone is ready to start the race."});
        }
    });

    socket.on('letterTyped', async ({lobbyCode, percentage}) =>{ //WPM
        let obj = await ioredis.get(socket.id);
        let {username: playerName} = JSON.parse(obj);
        if(percentage == 100){
            io.to(lobbyCode).emit('updateText', { 
                playerName: playerName, 
                percentage: percentage 
            });

            // await ioredis.get(lobbyCode);
            // let SQL = `SOMETHING SOMETHING ${lobbycode}`;
            // connection.query(SQL, (err, res, fields) =>{ //If the user has an account, we will log their race result.
            //     console.log(res);
            // });

        }
        else{
            io.to(lobbyCode).emit('updateText', { 
                playerName: playerName, 
                percentage: percentage 
            });
        }
    });

    socket.on('disconnecting', async (reason) =>{
        let user = await ioredis.get(socket.id);
        if(user != null){
            let {lobby: lobbyCode,leader} = JSON.parse(user);
            let members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
            if(leader && members.size > 1){
                let ids = members.values();
                let newLeader = null;
                while(newLeader == null || newLeader == socket.id){
                    newLeader = ids.next().value;
                }

                let transferPower = await ioredis.get(newLeader);
                let obj = JSON.parse(transferPower);
                obj.leader = true;
                let newObj = JSON.stringify(obj);
                await ioredis.set(newLeader, newObj);
            }
            await ioredis.del(socket.id);
    
            await updateLobby(lobbyCode);
        }
    });

    socket.on('disconnect', () => {
        console.log(`User ${socket.id} has disconnected`);
    });
});

console.log("app running");
