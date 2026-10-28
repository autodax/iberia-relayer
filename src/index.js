// Iberia relay: passes messages between the host and the guests of one room.
//
// Each room code gets its own Durable Object. The host and every guest keep one WebSocket open to it.
//  - guest -> relay: any text. The relay forwards it to the host as {g:<guest id>, d:<text>}.
//  - host  -> relay: {g:<guest id>, d:<text>} is forwarded to that guest as plain text.
//  - The relay tells the host {t:'open',g} when a guest joins and {t:'close',g} when one leaves.
//  - If the host disconnects, all guests are disconnected too (they reconnect on their own when the host returns).
// The relay never looks inside the game messages and stores nothing.
//
// Browsers send the text "ping" now and then. It is answered with "pong" without waking the room,
// which keeps connections alive without using up the free allowance.

const CODE = /^[A-Z0-9]{4,8}$/;
// Only these pages may use your relay. Add your own address here if you host the game somewhere else.
// Local testing (localhost and files opened from disk) is always allowed.
const ALLOWED_ORIGINS = ['https://autodax.github.io'];

function originAllowed(req) {
  const o = req.headers.get('Origin');
  if (!o || o === 'null') return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return true;
  return ALLOWED_ORIGINS.includes(o);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.headers.get('Upgrade') !== 'websocket') {
      // The game's "Test my connection" button calls this.
      return new Response('Iberia relay OK', { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' } });
    }
    if (!originAllowed(req)) return new Response('Not allowed from this page', { status: 403 });
    const m = /^\/room\/([A-Za-z0-9]+)$/.exec(url.pathname);
    const code = m && m[1].toUpperCase();
    if (!code || !CODE.test(code)) return new Response('Bad room code', { status: 400 });
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(req);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req) {
    const role = new URL(req.url).searchParams.get('role');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const host = this.state.getWebSockets('host')[0];

    if (role === 'host') {
      if (host) return this.refuse(client, server, 'taken');
      this.state.acceptWebSocket(server, ['host']);
      server.send(JSON.stringify({ t: 'ready' }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (role === 'guest') {
      if (!host) return this.refuse(client, server, 'notfound');
      const gid = crypto.randomUUID().slice(0, 8);
      this.state.acceptWebSocket(server, ['g:' + gid]);
      server.send(JSON.stringify({ t: 'ready' }));
      host.send(JSON.stringify({ t: 'open', g: gid }));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Unknown role', { status: 400 });
  }

  refuse(client, server, code) {
    this.state.acceptWebSocket(server, ['refused']);
    server.send(JSON.stringify({ t: 'error', code }));
    server.close(1008, code);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string') return;
    const tags = this.state.getTags(ws);
    if (tags.includes('host')) {
      let m;
      try { m = JSON.parse(msg); } catch (e) { return; }
      if (!m || typeof m.g !== 'string') return;
      for (const g of this.state.getWebSockets('g:' + m.g)) {
        if (m.t === 'kick') { try { g.close(1000, 'kicked'); } catch (e) {} }
        else if (typeof m.d === 'string') { try { g.send(m.d); } catch (e) {} }
      }
      return;
    }
    const tag = tags.find(t => t.startsWith('g:'));
    if (!tag) return;
    const host = this.state.getWebSockets('host')[0];
    if (host) { try { host.send(JSON.stringify({ g: tag.slice(2), d: msg })); } catch (e) {} }
  }

  async webSocketClose(ws, code) { this.gone(ws, code); }
  async webSocketError(ws) { this.gone(ws, 1011); }

  gone(ws, code) {
    const tags = this.state.getTags(ws);
    try { ws.close(code && code !== 1005 && code !== 1006 ? code : 1000, 'bye'); } catch (e) {}
    if (tags.includes('host')) {
      // The host left: send everyone home. Guests try to reconnect by themselves.
      for (const s of this.state.getWebSockets()) { if (s !== ws) { try { s.close(1012, 'host left'); } catch (e) {} } }
      return;
    }
    const tag = tags.find(t => t.startsWith('g:'));
    const host = this.state.getWebSockets('host')[0];
    if (tag && host) { try { host.send(JSON.stringify({ t: 'close', g: tag.slice(2) })); } catch (e) {} }
  }
}
