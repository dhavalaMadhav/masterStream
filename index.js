const express= require("express");
const app = express();
const http=require("http").Server(app);
const io =require("socket.io")(http, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });;
app.set("view engine", "ejs");
app.use(express.json());
app.use(express.urlencoded({extended: false}));
const { v4 :uuidv4}= require("uuid");
http.listen(3000, ()=>{
    console.log("running on port 3000");
})
object={};
const rooms = {};
// object of room ids and their corresponding socket ids
// app.use(express.static("C:/Users/SRUTHI/OneDrive/Desktop/server-3/app.html"));
io.on("connection", (socket)=>{
    socket.on('join-room', (roomId, userId) =>{
        socket.broadcast.emit("notify", userId)
        if (!rooms[roomId]) {
      rooms[roomId] = new Set();
    }
    rooms[roomId].add(userId);
    const allPeers = Array.from(rooms[roomId]);
    socket.emit('all-peers', allPeers);
    console.log(Array.from(rooms[roomId]));
        object[userId] = socket.id;
        console.log(object);
        socket.join(roomId)
        socket.to(roomId).emit('user-connected',userId);
            socket.on('message', (data, peerID)=>{
              io.to(roomId).emit('send_msg', data, peerID);
         })
        socket.on('message_pvt', (data, peer_id, other_id)=>{
            io.to(object[other_id]).emit("private", data, peer_id);
            console.log("private message sent to", other_id, object[`${other_id}`]);
        })
        socket.on('emoji', expression=>{
            io.sockets.emit('add_emoji', expression);
        })
        socket.on("disconnect", ()=>{
            socket.to(roomId).emit('user-disconnected', userId);
            rooms[roomId].delete(userId);
        })
        socket.on("participants", (id)=>{
            io.sockets.to(roomId).emit("listOfPart", Array.from(rooms[roomId]));
        })
        socket.on("delete", (peerId)=>{
            io.sockets.to(roomId).emit("delete_Part", peerId);
        })
    })
})
app.get("/", (req, res)=>{
    res.render('home');
    // res.redirect(`/${uuidv4()}`);
})
app.get('/join', (req, res)=>{
    res.render('join');
})  
app.get('/chat', (req, res)=>{
    res.render("chat");
})
app.get('/chat/:place', (req, res)=>{
    res.render('chat_page', { roomId: req.params.place });
})
app.get('/host', (req, res)=>{
    res.redirect(`/${uuidv4()}`);
})
// const path = require('path');
// const { stringify } = require("querystring");
app.get("/join/:room", (req, res)=>{
    res.render("app", {roomId: req.params.room});
})
app.get("/:room", (req, res) => {
    res.render('app', { roomId: req.params.room });
});
app.post("/getName", (req, res) => {
    const name = req.body.name;
})
