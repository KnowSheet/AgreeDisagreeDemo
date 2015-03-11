#!/bin/bash
# Demo use only. Images from lorempixel, all rights [p]reserved.
for i in `seq 10` ; do curl -s -H "Accept: image/jpg" http://lorempixel.com/400/400/nature/$i/ >$i.jpg ; done
