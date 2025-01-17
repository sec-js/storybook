import type { ChannelHandler } from '@storybook/core/channels';
import { Channel, HEARTBEAT_INTERVAL } from '@storybook/core/channels';

import { isJSON, parse, stringify } from 'telejson';
import WebSocket, { WebSocketServer } from 'ws';

type Server = NonNullable<NonNullable<ConstructorParameters<typeof WebSocketServer>[0]>['server']>;

/**
 * This class represents a channel transport that allows for a one-to-many relationship between the
 * server and clients. Unlike other channels such as the postmessage and websocket channel
 * implementations, this channel will receive from many clients and any events emitted will be sent
 * out to all connected clients.
 */
export class ServerChannelTransport {
  private socket: WebSocketServer;

  private handler?: ChannelHandler;

  isAlive = false;

  private heartbeat() {
    this.isAlive = true;
  }

  constructor(server: Server) {
    this.heartbeat = this.heartbeat.bind(this);

    this.socket = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      if (request.url === '/storybook-server-channel') {
        this.socket.handleUpgrade(request, socket, head, (ws) => {
          this.socket.emit('connection', ws, request);
        });
      }
    });
    this.socket.on('connection', (wss) => {
      this.isAlive = true;
      wss.on('message', (raw) => {
        const data = raw.toString();
        const event =
          typeof data === 'string' && isJSON(data)
            ? parse(data, { allowFunction: false, allowClass: false })
            : data;
        this.handler?.(event);
        if (event.type === 'pong') {
          this.heartbeat();
        }
      });
    });

    const interval = setInterval(() => {
      this.socket.clients.forEach((ws) => {
        if (this.isAlive === false) {
          return ws.terminate();
        }

        this.isAlive = false;
        this.send({ type: 'ping' });
      });
    }, HEARTBEAT_INTERVAL);

    this.socket.on('close', function close() {
      clearInterval(interval);
    });

    process.on('SIGTERM', () => {
      this.socket.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.close(1001, 'Server is shutting down');
        }
      });
      this.socket.close(() => process.exit(0));
    });
  }

  setHandler(handler: ChannelHandler) {
    this.handler = handler;
  }

  send(event: any) {
    const data = stringify(event, { maxDepth: 15, allowFunction: false, allowClass: false });

    Array.from(this.socket.clients)
      .filter((c) => c.readyState === WebSocket.OPEN)
      .forEach((client) => client.send(data));
  }
}

export function getServerChannel(server: Server) {
  const transports = [new ServerChannelTransport(server)];

  return new Channel({ transports, async: true });
}

// for backwards compatibility
export type ServerChannel = ReturnType<typeof getServerChannel>;
