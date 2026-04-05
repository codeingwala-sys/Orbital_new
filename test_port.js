import http from "http";
const server = http.createServer((req, res) => {
  res.end("ok");
});
server.listen(3099, () => {
  console.log("Listen success 3099");
  process.exit(0);
});
