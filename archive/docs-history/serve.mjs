import { createServer } from 'http'
import { readFile } from 'fs/promises'
import { extname, join } from 'path'

const DIST = join(process.cwd(), '.vitepress', 'dist')
const PORT = 8080

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

const server = createServer(async (req, res) => {
  try {
    let url = req.url?.split('?')[0] || '/'
    if (url === '/') url = '/index.html'
    // clean URLs: /architecture -> /architecture.html
    let filePath = join(DIST, url)
    // try as-is first
    let data
    try {
      data = await readFile(filePath)
    } catch {
      // try with .html
      filePath = join(DIST, url + '.html')
      data = await readFile(filePath)
    }
    const ext = extname(filePath)
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    res.end(data)
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found: ' + req.url)
  }
})

server.listen(PORT, () => {
  console.log(`GCA Docs serving on http://localhost:${PORT}`)
})
