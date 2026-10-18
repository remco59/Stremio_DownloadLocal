#!/bin/sh
# Regenerates the short status clips in clips/ that /play serves when it cannot play the real file yet.
# Needs ffmpeg with libx264, aac and drawtext, plus a TTF font (DejaVu Sans by default; set FONT=...).
set -eu
cd "$(dirname "$0")/.."
FONT="${FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf}"
SECONDS_LONG=600 # long on purpose: a clip that ends lets Stremio auto-play the next episode

# clip <name> <accent colour> <title> <line 2>
clip() {
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "color=c=0x0f1115:s=1280x720:r=2:d=${SECONDS_LONG}" \
    -f lavfi -i "anullsrc=r=48000:cl=stereo" \
    -vf "drawbox=x=0:y=ih-12:w=iw*t/${SECONDS_LONG}:h=12:color=$2:t=fill,\
drawtext=fontfile=${FONT}:text='$3':fontcolor=white:fontsize=56:x=(w-tw)/2:y=(h/2)-80,\
drawtext=fontfile=${FONT}:text='$4':fontcolor=0x8b93a1:fontsize=34:x=(w-tw)/2:y=(h/2)+10" \
    -t "${SECONDS_LONG}" -shortest \
    -c:v libx264 -g 120 -profile:v main -pix_fmt yuv420p -preset veryslow -crf 30 -tune stillimage \
    -c:a aac -b:a 32k -movflags +faststart \
    "clips/$1.mp4"
  echo "clips/$1.mp4 $(wc -c < "clips/$1.mp4") bytes"
}

clip started  0x7b5cff 'Download started on your server' 'Come back in a bit - Stremio then shows it as Your server.'
clip metadata 0x7b5cff 'Looking for the torrent...' 'The download is being set up. Try again in a minute.'
clip error    0xff6b6b 'Could not start the download' 'No usable torrent was found. Check the add-on web page.'
