import http from "http";
import { Server } from "socket.io";
import app from "./app.js";
import jwt from "jsonwebtoken";
import MessageService from "./services/MessageService.js";
import User from "./models/User.js";
import MembershipService from "./services/MembershipService.js";

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Socket.IO Authentication Middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication error"));
  
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error("Authentication error"));
    socket.user = decoded;
    next();
  });
});

io.on("connection", (socket) => {
  console.log(`User ${socket.user.id} connected`);

  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.user.id} joined room ${roomId}`);
  });

  socket.on("client-message-created", async (message, callback) => {
    try {
      const newMessage = await MessageService.createMessage({
        ...message,
        sender: socket.user.id
      });
  
      io.to(message.room.toString()).emit("server-message-created", newMessage);
      console.log("server-message-created", message);
      
      callback({ status: "success", data: message });
    } catch (error) {
      callback({ status: "error", error: error.message });
    }
  });

  socket.on("client-message-updated", async (messageData, callback) => {
    try {
      if (!messageData.room) {
        throw new Error('Room ID is required for message update');
      }
      
      const roomId = messageData.room.toString();

      // Force rejoin room to ensure membership
      await socket.join(roomId);
      
      // Verify room membership
      const room = io.sockets.adapter.rooms.get(roomId);

      const message = await MessageService.updateMessage(messageData);
      
      io.to(roomId).emit("server-message-updated", message);

      callback({ status: "success", data: message });
    } catch (error) {
      console.error('Update error:', error);
      callback({ status: "error", error: error.message });
    }
  });

  socket.on("client-message-deleted", async (messageId, callback) => {
    try {
      const deletedMessage = await MessageService.deleteMessage(messageId);
      io.to(deletedMessage.room.toString()).emit("server-message-deleted", deletedMessage);
      callback({ status: "success", data: deletedMessage });
    } catch (error) {
      callback({ status: "error", error: error.message });
    }
  });
  const typingTimeouts = new Map();
  
  socket.on('typing-start', async (roomId) => {
    try {
      const timeoutKey = `${roomId}-${socket.user.id}`;
      const user = await User.findById(socket.user.id);
  
      clearTimeout(typingTimeouts.get(timeoutKey));
  
      // Emit only to others in the room (not to the sender)
      // This didn't work even though the socket.to does not send it to the user who emitted the event 
      socket.to(roomId).emit('user-typing', {
        roomId,
        userId: socket.user.id,
        userName: `${user.firstName} ${user.lastName}`
      });
  
      // Set auto-stop timeout
      typingTimeouts.set(timeoutKey, setTimeout(() => {
        socket.to(roomId).emit('user-stopped-typing', {
          roomId,
          userId: socket.user.id,
        });
        typingTimeouts.delete(timeoutKey);
      }, 3000));
    } catch (error) {
      console.error('Error in typing-start:', error);
    }
  });
  
  socket.on('typing-stop', (roomId) => {
    try {
      const timeoutKey = `${roomId}-${socket.user.id}`;
      clearTimeout(typingTimeouts.get(timeoutKey));
      typingTimeouts.delete(timeoutKey);
      
      // Emit only to others in the room (not to the sender)
      socket.to(roomId).emit('user-stopped-typing', {
        roomId,
        userId: socket.user.id
      });
    } catch (error) {
      console.error('Error in typing-stop:', error);
    }
  });

  socket.on("disconnect", () => {
    // cleaning up all the timeoutes of thje typing indicators 
    for (const [key, timeout] of typingTimeouts.entries()) {
      if (key.includes(socket.user.id)) {
        clearTimeout(timeout);
        typingTimeouts.delete(key);
      }
    }
    console.log(`User ${socket.user.id} disconnected`);
  });
  // WebRTC Signaling Events
  const activeCalls = new Map(); // roomId => { participants: Set<userId>, offer: any, answer: any }

  socket.on('call-initiate', async ({ roomId, offer, callType }) => {
    try {
      console.log("test",roomId)
      // Verify user is part of the room
      const roomMembers = await MembershipService.getRoomMembers(roomId); // Implement your room membership check
      if (!roomMembers.includes(socket.user.id)) {
        throw new Error('Unauthorized call initiation');
      }

      // Create new call entry
      activeCalls.set(roomId, {
        participants: new Set([socket.user.id]),
        offer,
        answer: null,
        callType,
        initiator: socket.user.id
      });

      // Notify other room members
      socket.to(roomId).emit('call-incoming', {
        roomId,
        offer,
        callType,
        initiator: socket.user.id
      });
    } catch (error) {
      socket.emit('call-error', { error: error.message });
    }
  });

  socket.on('call-answer', ({ roomId, answer }) => {
    const call = activeCalls.get(roomId);
    if (!call) {
      return socket.emit('call-error', { error: 'Call no longer exists' });
    }

    call.answer = answer;
    call.participants.add(socket.user.id);
    
    // Send answer to initiator
    socket.to(call.initiator).emit('call-answer-received', { answer });
  });

  socket.on('ice-candidate', ({ roomId, candidate }) => {
    console.log(candidate)
    // Validate candidate structure before broadcasting
    const validatedCandidate = {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid || null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      usernameFragment: candidate.usernameFragment || null
    };
    
    socket.to(roomId).emit('ice-candidate', {
      candidate: validatedCandidate,
      senderId: socket.user.id
    });
  });

  socket.on('call-end', ({ roomId }) => {
    const call = activeCalls.get(roomId);
    if (!call) return;

    // Notify all participants
    io.to(roomId).emit('call-ended', { endedBy: socket.user.id });
    activeCalls.delete(roomId);
  });

  socket.on('call-reject', ({ roomId }) => {
    const call = activeCalls.get(roomId);
    if (call?.initiator) {
      socket.to(call.initiator).emit('call-rejected', {
        rejecterId: socket.user.id
      });
    }
  });

  // Modify disconnect handler
  socket.on("disconnect", () => {
    // Clean up any active calls the user was part of
    activeCalls.forEach((call, roomId) => {
      if (call.participants.has(socket.user.id)) {
        io.to(roomId).emit('call-ended', { 
          endedBy: socket.user.id,
          reason: 'participant-left'
        });
        activeCalls.delete(roomId);
      }
    });
  });
  
});

app.set("io", io);

server.listen(process.env.PORT, () => {
  console.log(`Server running on port: ${process.env.PORT}`);
});