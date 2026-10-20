#!/bin/bash
STATUS=$(gnome-extensions info ubuntu-dock@ubuntu.com | grep State)

if [[ "$STATUS" == *"ENABLED"* ]]; then
    gnome-extensions disable ubuntu-dock@ubuntu.com
else
    gnome-extensions enable ubuntu-dock@ubuntu.com
fi

