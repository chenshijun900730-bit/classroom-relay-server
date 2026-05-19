const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;

// MIME 类型映射
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json'
};

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/client.html' : req.url;
  filePath = path.join(__dirname, filePath);
  
  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = mimeTypes[extname] || 'application/octet-stream';
  
  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end('Server Error: ' + error.code);
      }
    } else {
      res.writeHead(200, { 
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content, 'utf-8');
    }
  });
});

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ server });

// 存储房间信息
const rooms = new Map();

wss.on('connection', (ws) => {
  let currentRoom = null;
  let clientType = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'join':
          currentRoom = data.room;
          clientType = data.clientType;
          
          if (!rooms.has(currentRoom)) {
            rooms.set(currentRoom, new Set());
          }
          rooms.get(currentRoom).add(ws);
          
          // 通知房间内其他客户端
          broadcast(currentRoom, {
            type: 'user_joined',
            clientType: clientType,
            timestamp: Date.now()
          }, ws);
          
          // 发送确认
          ws.send(JSON.stringify({
            type: 'joined',
            room: currentRoom,
            clientCount: rooms.get(currentRoom).size
          }));
          break;
          
        case 'call':
          if (currentRoom) {
            broadcast(currentRoom, {
              type: 'call',
              name: data.name,
              timestamp: Date.now()
            });
          }
          break;
          
        case 'broadcast':
          if (currentRoom) {
            broadcast(currentRoom, {
              type: 'broadcast',
              message: data.message,
              timestamp: Date.now()
            });
          }
          break;
          
        case 'student_list':
          if (currentRoom) {
            broadcast(currentRoom, {
              type: 'student_list',
              students: data.students,
              timestamp: Date.now()
            }, ws);
          }
          break;
      }
    } catch (e) {
      console.error('Message error:', e);
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(ws);
      if (rooms.get(currentRoom).size === 0) {
        rooms.delete(currentRoom);
      }
    }
  });
});

function broadcast(room, message, excludeWs = null) {
  if (rooms.has(room)) {
    const messageStr = JSON.stringify(message);
    rooms.get(room).forEach((client) => {
      if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    });
  }
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
