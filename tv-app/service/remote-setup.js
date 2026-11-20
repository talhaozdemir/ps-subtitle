'use strict';

const crypto = require('crypto');
const https = require('https');

const host = 'ps-subtitle.u-talha-o.workers.dev';
const origin = 'https://' + host;
const agent = new https.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 1 });
const connectionError = 'Kurulum servisine ulaşılamadı. TV’nin internet bağlantısını kontrol et.';

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function request(method, id, token, payload) {
  const body = payload ? JSON.stringify(payload) : '';
  const headers = { Authorization: 'Bearer ' + token, 'User-Agent': 'PS-Subtitle-webOS/1.0',
    'Content-Length': Buffer.byteLength(body) };
  if (body) headers['Content-Type'] = 'application/json';
  return new Promise(function (resolve, reject) {
    let timer;
    function fail() {
      clearTimeout(timer);
      reject(Error(connectionError));
    }
    const client = https.request({
      hostname: host, method: method, path: '/api/setup/' + id, agent: agent, headers: headers
    }, function (incoming) {
      let bytes = 0;
      const chunks = [];
      incoming.on('data', function (chunk) {
        bytes += chunk.length;
        if (bytes > 8300) {
          client.destroy();
          fail();
          return;
        }
        chunks.push(chunk);
      });
      incoming.on('error', fail);
      incoming.on('aborted', fail);
      incoming.on('end', function () {
        clearTimeout(timer);
        resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    timer = setTimeout(function () { client.destroy(); fail(); }, 6500);
    client.on('error', fail);
    client.end(body);
  });
}

function createRemoteTransfer() {
  const code = crypto.randomBytes(16).toString('hex');
  const readToken = crypto.randomBytes(32).toString('hex');
  function derived(label) { return hash('ps-subtitle/setup/v1/' + label + '/' + code); }
  const id = derived('id').slice(0, 32);
  const key = Buffer.from(derived('key'), 'hex');

  function decrypt(body) {
    try {
      const packet = JSON.parse(body);
      if (!packet || typeof packet.iv !== 'string' || !/^[0-9a-f]{24}$/.test(packet.iv) ||
          typeof packet.ciphertext !== 'string' || !/^(?:[0-9a-f]{2}){17,4096}$/.test(packet.ciphertext)) {
        throw Error('Invalid packet');
      }
      const encrypted = Buffer.from(packet.ciphertext, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(packet.iv, 'hex'));
      decipher.setAAD(Buffer.from(id, 'utf8'));
      decipher.setAuthTag(encrypted.slice(-16));
      return JSON.parse(Buffer.concat([decipher.update(encrypted.slice(0, -16)), decipher.final()]).toString('utf8'));
    } catch (error) { throw Error('Gelen ayarlar doğrulanamadı. Yeni bir oturum aç.'); }
  }

  return {
    address: host,
    code: code,
    link: origin + '/#' + code,
    start: function () {
      return request('POST', id, readToken, { uploadHash: hash(derived('upload')) }).then(function (reply) {
        if (reply.status === 429) throw Error('Çok fazla kurulum denemesi yapıldı. Biraz bekle.');
        if (reply.status !== 201) throw Error(connectionError);
      });
    },
    read: function () {
      return request('GET', id, readToken).then(function (reply) {
        if (reply.status === 204) return null;
        if (reply.status === 404) throw Error('Kurulum oturumu sona erdi. Yeni bir oturum aç.');
        if (reply.status !== 200) throw Error(connectionError);
        return { data: decrypt(reply.body) };
      });
    },
    close: function () { return request('DELETE', id, readToken); }
  };
}

module.exports = { createRemoteTransfer };
