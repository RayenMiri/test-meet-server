import http from "http";
import { Server } from "socket.io";
import app from "./app.js";
import MembershipService from "./services/MembershipService.js";

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// // Socket.IO Authentication Middleware
// io.use((socket, next) => {
//   const token = socket.handshake.auth.token;
//   if (!token) return next(new Error("Authentication error"));
  
//   jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
//     if (err) return next(new Error("Authentication error"));
//     socket.user = decoded;
//     next();
//   });
// });

io.on("connection", (socket) => {
  console.log(`User ${socket.user.id} connected`);

  // WebRTC Signaling Events
  const activeCalls = new Map(); // roomId => { participants: Set<userId>, offer: any, answer: any }

  socket.on('call-initiate', async ({ roomId, offer, callType }) => {
    try {
      console.log("test", roomId);
      // Verify user is part of the room
      const roomMembers = await MembershipService.getRoomMembers(roomId);
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
    console.log(candidate);
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

  socket.on("disconnect", () => {
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
