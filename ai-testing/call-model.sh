curl http://192.168.68.123:1919/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{
    "model": "gpt-oss-20b",
    "messages": [{"role": "user", "content": "Hello from remote PC!"}]
    }'