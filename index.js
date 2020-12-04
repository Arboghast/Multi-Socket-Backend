
//require('dotenv').config();
//const mysql = require('mysql');
// const connection = mysql.createConnection({
//     host: process.env.DB_HOST,
//     user: process.env.USER,
//     password: process.env.PASSWORD
// });
const LOBBY_LIMIT = 7;
const io = require('socket.io')(8000,{cors: true});
const redis = require('socket.io-redis');
const ior = require('ioredis');
const ioredis = new ior(6379, "10.93.224.3");

io.adapter(redis({host: "10.93.224.3", port: 6379}));
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

        let json = JSON.stringify({ username: username, ready: false, leader: true });
        await ioredis.set(socket.id, json);

        socket.emit('createLobbyResponse', {
            lobbyCode : lobbyCode
        });
    });

    socket.on('joinLobby', async ({lobbyCode, username}) =>{
        let rooms = await io.of('/').adapter.allRooms();
        let members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
        let gameInProgress = await ioredis.get(lobbyCode);

        if(rooms.has(lobbyCode) && !members.has(socket.id) && members.size <= LOBBY_LIMIT && gameInProgress == null){
            socket.join(lobbyCode);
            let json = JSON.stringify({ username: username, ready: false, leader: false });
            await ioredis.set(socket.id, json);

            await updateLobby(lobbyCode);
        }
        else{
            socket.emit('lobbyUpdate', { error: "Lobby cannot be joined."}); 
        }
    });

    socket.on('leaveLobby', async ({lobbyCode})=>{
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

    socket.on('startRace', async ({lobbyCode}) =>{
        let flag = await readyCheck(lobbyCode);
        if(flag){
            let text = [];
            /*
                ->  Make db query and send text to frontend and populate text
            */
            text.push("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Maecenas semper libero.");

            let members = await io.of('/').adapter.sockets(new Set([lobbyCode]));
            ioredis.set(lobbyCode, members.length); //disallows users to join lobby while race in progress
            
            io.to(lobbyCode).emit('raceInit', text);
        }
        else{
            io.to(lobbyCode).emit('raceInit', { error: "Not everyone is ready to start the race."});
        }
    });

    socket.on('letterTyped', async (lobbyCode, playerName, percentage) =>{ //WPM
        if(percentage == 100){
            io.to(lobbyCode).emit('updateText', { 
                playerName: playerName, 
                percentage: percentage 
            });

            await ioredis.get(lobbyCode);
            let SQL = `SOMETHING SOMETHING ${lobbycode}`;
            connection.query(SQL, (err, res, fields) =>{ //If the user has an account, we will log their race result.
                console.log(res);
            });

            await ioredis.del(lobbyCode);
        }
        else{
            io.to(lobbyCode).emit('updateText', { 
                playerName: playerName, 
                percentage: percentage 
            });
        }
    });

    // socket.on('disconnnecting', () =>{

    // });

    socket.on('disconnect', () => {
        console.log(`User ${socket.id} has disconnected`);
    });
});

console.log("app running");
