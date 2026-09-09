const http = require('http');
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'boss-homepage.html');
http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(file));
}).listen(4173, () => console.log('demo server on 4173'));
