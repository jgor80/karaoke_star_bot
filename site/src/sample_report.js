// The public sample on the home page ("see a real report"): one real night's numbers, frozen,
// with the bar's name and the dates taken out (Jeff, 2026-11-18). Served at /sample-report.
// To refresh it, copy a night from /<slug>/api/report and keep the name and dates out.
export const SAMPLE_REPORT = {
  sample: true,
  venue: "A neighborhood bar",
  stats: {
    songs: 53, guest_songs: 51, host_songs: 2, singers: 38, first_timers: 19, returning: 19, groups: 7,
    start: "9:32 PM", end: "1:14 AM", hours_singing: 3.8, songs_per_hour: 14.1, busiest_hour: 22,
    by_hour: { 0: 14, 1: 3, 21: 6, 22: 15, 23: 15 },
    regulars: 23, regulars_came: 11, last_week_back: 19, applause_avg: null, big_ovations: 0,
    reactions: 46, phones: 8, draft_picks: 0, duet_posts: 0, duet_matches: 0,
  },
  compare: { nights: 4, songs: 57.3, guest_songs: 55, singers: 41.8, first_timers: 32, hours_singing: 4.1 },
  season: { nights: 7, songs: 339, guests: 201 },
};
