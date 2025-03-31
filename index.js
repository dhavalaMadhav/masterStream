const express= require("express");
const app = express();
const http=require("http").Server(app);
const io =require("socket.io")(http);
app.set("view engine", "ejs");
const { v4 :uuidv4}= require("uuid");
http.listen(3000, ()=>{
    console.log("running on port 3000");
})
// app.use(express.static("C:/Users/SRUTHI/OneDrive/Desktop/server-3/app.html"));
io.on("connection", (socket)=>{
    socket.on('join-room', (roomId, userId) =>{
        socket.join(roomId)
        socket.to(roomId).emit('user-connected',userId);
            socket.on('message', (data, peerID)=>{
              io.to(roomId).emit('send_msg', data, peerID);
         })
        socket.on('message_pvt', (data, peer_id, other_id)=>{
            io.to(other_id).emit("private", data, peer_id);
        })
        socket.on("disconnect", ()=>{
            socket.to(roomId).emit('user-disconnected', userId);
        })
        socket.on("participants", (id)=>{
            io.sockets.to(roomId).emit("listOfPart", id);
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
const path = require('path');
app.get("/:room", (req, res) => {
    res.render('app', { roomId: req.params.room });
});
