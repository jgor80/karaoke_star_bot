// Song ids come from three ranges. Every lookup by id goes through here so the ranges stay in one place.
//   1 .. OWN_BASE-1            catalog: songs sung here, kept at their old KaraFun id (plays.song_id)
//   OWN_BASE .. KV_ID_BASE-1   songbook: a bar's own uploaded list (songbook.rowid)
//   KV_ID_BASE .. MAX_SONG_ID  catalog: Karaoke Version songs never sung here (KV_ID_BASE + their song id)
export const OWN_BASE = 1e9;
export const KV_ID_BASE = 3e9;
export const MAX_SONG_ID = 4e9;

export const validSongId = (id) => Number.isInteger(id) && id > 0 && id < MAX_SONG_ID;
// Which table holds this id: "songbook" or "catalog".
export const songTable = (id) => (Number(id) >= OWN_BASE && Number(id) < KV_ID_BASE ? "songbook" : "catalog");
