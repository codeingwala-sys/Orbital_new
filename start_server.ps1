$process = Start-Process node -ArgumentList "server.js" -PassThru -NoNewWindow -RedirectStandardOutput "server_log.txt" -RedirectStandardError "server_error.txt"
echo $process.Id > server_pid.txt
