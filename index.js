const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;

// ============================================
// 阿里云 TTS 配置
// 请在 Render 环境变量中设置以下值：
//   ALIYUN_ACCESS_KEY_ID     - 阿里云 AccessKey ID
//   ALIYUN_ACCESS_KEY_SECRET - 阿里云 AccessKey Secret
//   ALIYUN_TTS_APPKEY        - 智能语音交互项目的 AppKey
// ============================================
const ALIYUN_ACCESS_KEY_ID = process.env.ALIYUN_ACCESS_KEY_ID || '';
const ALIYUN_ACCESS_KEY_SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET || '';
const ALIYUN_TTS_APPKEY = process.env.ALIYUN_TTS_APPKEY || '';

// TTS Token 缓存
let ttsToken = null;
let ttsTokenExpireTime = 0;

// MIME 类型映射
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json'
};

// ============================================
// 阿里云 TTS Token 获取
// ============================================
function getTtsToken() {
  return new Promise((resolve, reject) => {
    // 如果 token 还有效，直接返回
    if (ttsToken && Date.now() < ttsTokenExpireTime) {
      return resolve(ttsToken);
    }

    if (!ALIYUN_ACCESS_KEY_ID || !ALIYUN_ACCESS_KEY_SECRET) {
      return reject(new Error('阿里云 AccessKey 未配置'));
    }

    // 使用 POP API 获取 Token
    const params = new URLSearchParams({
      AccessKeyId: ALIYUN_ACCESS_KEY_ID,
      Action: 'CreateToken',
      Format: 'JSON',
      RegionId: 'cn-shanghai',
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: Date.now().toString() + Math.random().toString(36).substr(2),
      SignatureVersion: '1.0',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Version: '2019-02-28'
    });

    // 按 key 排序
    const sortedKeys = Array.from(params.keys()).sort();
    const canonicalQuery = sortedKeys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params.get(k))}`).join('&');

    // 构造签名字符串
    const stringToSign = `GET&${encodeURIComponent('/')}&${encodeURIComponent(canonicalQuery)}`;

    // HMAC-SHA1 签名
    const crypto = require('crypto');
    const signature = crypto.createHmac('sha1', ALIYUN_ACCESS_KEY_SECRET + '&')
      .update(stringToSign).digest('base64');

    params.append('Signature', signature);

    const tokenUrl = `https://nls-meta.cn-shanghai.aliyuncs.com/?${params.toString()}`;

    https.get(tokenUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.Token) {
            ttsToken = result.Token.Id;
            // Token 有效期通常为 24 小时，提前 1 小时刷新
            ttsTokenExpireTime = Date.now() + (result.Token.ExpireTime - 3600) * 1000;
            console.log('TTS Token 获取成功，有效期至:', new Date(ttsTokenExpireTime).toLocaleString());
            resolve(ttsToken);
          } else {
            reject(new Error('获取 Token 失败: ' + JSON.stringify(result)));
          }
        } catch (e) {
          reject(new Error('解析 Token 响应失败: ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

// ============================================
// 阿里云 TTS 语音合成
// ============================================
function synthesizeSpeech(text, voice = 'xiaoyun') {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getTtsToken();

      const ttsParams = new URLSearchParams({
        appkey: ALIYUN_TTS_APPKEY,
        token: token,
        text: text,
        format: 'mp3',
        sample_rate: '16000',
        voice: voice,
        volume: '50',
        speech_rate: '0',
        pitch_rate: '0'
      });

      const ttsUrl = `https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/tts?${ttsParams.toString()}`;

      https.get(ttsUrl, (res) => {
        const contentType = res.headers['content-type'];
        if (contentType && contentType.includes('audio')) {
          // 成功 - 返回音频数据
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            resolve(Buffer.concat(chunks));
          });
        } else {
          // 失败
          let errMsg = '';
          res.on('data', chunk => errMsg += chunk);
          res.on('end', () => {
            reject(new Error('TTS 合成失败: ' + errMsg));
          });
        }
      }).on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

// 创建 HTTP 服务器
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // TTS API 路由
  if (pathname === '/api/tts') {
    const text = parsedUrl.query.text;
    const voice = parsedUrl.query.voice || 'xiaoyun';

    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '缺少 text 参数' }));
      return;
    }

    if (!ALIYUN_ACCESS_KEY_ID || !ALIYUN_ACCESS_KEY_SECRET || !ALIYUN_TTS_APPKEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '阿里云 TTS 未配置，请在 Render 环境变量中设置 ALIYUN_ACCESS_KEY_ID、ALIYUN_ACCESS_KEY_SECRET、ALIYUN_TTS_APPKEY' }));
      return;
    }

    try {
      console.log('TTS 请求:', text.substring(0, 30) + (text.length > 30 ? '...' : ''));
      const audioBuffer = await synthesizeSpeech(text, voice);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length,
        'Cache-Control': 'no-cache'
      });
      res.end(audioBuffer);
    } catch (e) {
      console.error('TTS 错误:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 静态文件服务
  let filePath = pathname === '/' ? '/client.html' : pathname;
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
  if (ALIYUN_ACCESS_KEY_ID && ALIYUN_ACCESS_KEY_SECRET && ALIYUN_TTS_APPKEY) {
    console.log('阿里云 TTS 已配置 ✓');
  } else {
    console.log('阿里云 TTS 未配置，将使用浏览器内置语音（请设置环境变量 ALIYUN_ACCESS_KEY_ID、ALIYUN_ACCESS_KEY_SECRET、ALIYUN_TTS_APPKEY）');
  }
});
