#!/bin/bash

# Check if the PID file exists
if [ -f server.pid ]; then
    # Read the PID from the file
    PID=$(cat server.pid)
    
    # Kill the process
    kill $PID
    
    # Remove the PID file
    rm server.pid
    
    echo "Server with PID $PID has been stopped"
else
    echo "No server PID found (server.pid file doesn't exist)"
    echo "You might need to manually find and kill the process:"
    echo "ps aux | grep 'python -m http.server'"
fi
