#!/bin/bash

# Demo use only. Images from lorempixel, all rights [p]reserved.

mkdir -p lorempixel

cat <<EOF >lorempixel/LICENSE.txt
The images from Lorempixel are used, with all the rights [p]reserved.
EOF

for i in `seq 10` ; do
  curl -s -H "Accept: image/jpg" http://lorempixel.com/400/400/nature/$i/ >lorempixel/$i.jpg
done
