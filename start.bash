#!/bin/bash

# Start the Python HTTP server in the background
nohup python -m http.server --directory public --bind :: 8099 > server.log 2>&1 &

# Save the PID to a file for later use
echo $! > server.pid

echo "Server started in background with PID $(cat server.pid)"
echo "Output is being logged to server.log"
