import { createReadStream, promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import {
  handleTravelApiRequest,
  initializeTravelApi
} from './travelApi';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 4173;
const staticRootDir = resolve(process.cwd(), 'dist');

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp'
};

function getHost() {
  return process.env.HOST ?? DEFAULT_HOST;
}

function getPort() {
  const parsedPort = Number(process.env.PORT);
  return Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
}

function sendText(response: ServerResponse, statusCode: number, message: string) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end(`${message}\n`);
}

function sendEmpty(response: ServerResponse, statusCode: number) {
  response.statusCode = statusCode;
  response.end();
}

function getStaticFilePath(request: IncomingMessage) {
  try {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const decodedPath = decodeURIComponent(requestUrl.pathname);
    const normalizedPath = decodedPath.endsWith('/')
      ? `${decodedPath}index.html`
      : decodedPath;
    const filePath = resolve(staticRootDir, `.${normalizedPath}`);

    if (filePath !== staticRootDir && !filePath.startsWith(`${staticRootDir}${sep}`)) {
      return null;
    }

    return filePath;
  } catch {
    return null;
  }
}

function shouldServeSpaFallback(request: IncomingMessage) {
  return request.headers.accept?.includes('text/html') ?? false;
}

async function streamFile(
  filePath: string,
  request: IncomingMessage,
  response: ServerResponse
) {
  const fileStats = await fs.stat(filePath);

  if (!fileStats.isFile()) {
    sendText(response, 404, 'Not found.');
    return;
  }

  response.statusCode = 200;
  response.setHeader(
    'Content-Type',
    contentTypes[extname(filePath)] ?? 'application/octet-stream'
  );
  response.setHeader('Content-Length', fileStats.size.toString());

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
}

async function serveStaticAsset(
  request: IncomingMessage,
  response: ServerResponse
) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendEmpty(response, 405);
    return;
  }

  const filePath = getStaticFilePath(request);

  if (!filePath) {
    sendText(response, 400, 'Bad request.');
    return;
  }

  try {
    await streamFile(filePath, request, response);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (shouldServeSpaFallback(request)) {
        await streamFile(resolve(staticRootDir, 'index.html'), request, response);
        return;
      }

      sendText(response, 404, 'Not found.');
      return;
    }

    throw error;
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse
) {
  try {
    if (await handleTravelApiRequest(request, response)) {
      return;
    }

    await serveStaticAsset(request, response);
  } catch (error) {
    console.error(error);

    if (!response.headersSent) {
      sendText(response, 500, 'Internal server error.');
    } else {
      response.end();
    }
  }
}

await initializeTravelApi();

const server = createServer((request, response) => {
  void handleRequest(request, response);
});

server.listen(getPort(), getHost(), () => {
  console.log(`Travel app listening on http://${getHost()}:${getPort()}`);
});
