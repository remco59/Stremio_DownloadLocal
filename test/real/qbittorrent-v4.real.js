// qBittorrent 4.x: login answers "Ok.", and pause/resume instead of 5.x's stop/start.
require('./suite')({ client: 'qbittorrent', image: process.env.REAL_QB4_IMAGE || 'lscr.io/linuxserver/qbittorrent:4.6.7' });
