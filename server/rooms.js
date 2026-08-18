import { Room } from './room.js';
import { CONFIG } from './config.js';
import { roomCode, now } from './util.js';

/**
 * Raum-Registry. Ein Raum lebt, solange jemand verbunden ist; danach bleibt er
 * noch eine Weile stehen (jemand lädt die Seite neu) und wird dann abgeräumt.
 */
class RoomRegistry {
  constructor() {
    this.rooms = new Map();
    this.reaper = setInterval(() => this.reap(), 60000);
    this.reaper.unref?.();
  }

  create() {
    let code = roomCode();
    let attempts = 0;
    while (this.rooms.has(code) && attempts++ < 50) code = roomCode();
    const room = new Room(code, { onEmpty: (r) => { r.emptySince = now(); } });
    room.emptySince = now();
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code || '').toUpperCase().trim()) || null;
  }

  reap() {
    for (const [code, room] of this.rooms) {
      const idle = room.connections.size === 0 && room.emptySince && now() - room.emptySince > CONFIG.roomTtlMs;
      const stale = room.connections.size === 0 && !room.players.size && now() - room.createdAt > 600000;
      if (idle || stale) {
        room.dispose();
        this.rooms.delete(code);
      }
    }
  }

  stats() {
    let players = 0;
    let running = 0;
    for (const room of this.rooms.values()) {
      players += room.players.size;
      if (room.inGame) running++;
    }
    return { rooms: this.rooms.size, players, running };
  }
}

export const rooms = new RoomRegistry();
