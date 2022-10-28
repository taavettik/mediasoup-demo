import fs from 'fs';
import path from 'path';
import { config } from './config';
import https from 'http';
import express from 'express';
import socketIo from 'socket.io';
import mediasoup, { createWorker } from 'mediasoup';
import { Room } from './Room';
import { Peer } from './Peer';

const options = {
  //  key: fs.readFileSync(path.join(__dirname, config.sslKey), 'utf-8'),
  //  cert: fs.readFileSync(path.join(__dirname, config.sslCrt), 'utf-8'),
};

const app = express();

const httpsServer = https.createServer(options, app);

const io = new socketIo.Server(httpsServer, {
  cors: {
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST'],
  },
});
app.use(express.static(path.join(__dirname, '..', 'public')));
//app.use(express.static(path.join(__dirname, '..', 'client/dist')));

httpsServer.listen(8080, () => {
  console.log(
    'Listening on https://' + config.listenIp + ':' + config.listenPort,
  );
});

const workers: mediasoup.types.Worker[] = [];
let nextMediasoupWorkerId = 0;

const rooms = new Map<string, Room>();

async function createWorkers() {
  const { numWorkers } = config.mediasoup;

  for (let i = 0; i < numWorkers; i++) {
    const worker = await createWorker({
      rtcMinPort: config.mediasoup.worker.rtcMinPort,
      rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
    });

    worker.on('died', () => {
      console.error(
        `Mediasoup worker died, exiting in 2 seconds...`,
        worker.pid,
      );
      setTimeout(() => process.exit(1), 2000);
    });

    workers.push(worker);
  }
}

async function setup() {
  await createWorkers();
}

function getMediasoupWorker() {
  const worker = workers[nextMediasoupWorkerId];

  if (++nextMediasoupWorkerId === workers.length) nextMediasoupWorkerId = 0;

  return worker;
}

setup();

io.on('connection', (socket) => {
  socket.on('createRoom', async ({ room_id }, callback) => {
    if (rooms.has(room_id)) {
      callback('already exists');
    } else {
      console.log('Created room', { room_id: room_id });
      const worker = await getMediasoupWorker();
      rooms.set(room_id, new Room(room_id, worker, io));
      callback(room_id);
    }
  });

  socket.on('join', ({ room_id, name }, cb) => {
    console.log('User joined', {
      room_id: room_id,
      name: name,
    });

    if (!rooms.has(room_id)) {
      return cb({
        error: 'Room does not exist',
      });
    }

    rooms.get(room_id)?.addPeer(new Peer(socket.id, name));
    socket.data = { roomId: room_id };

    cb(rooms.get(room_id)?.toJson());
  });

  socket.on('getProducers', () => {
    if (!rooms.has(socket.data.roomId)) return;
    console.log('Get producers', {
      name: `${rooms.get(socket.data.roomId)?.getPeers().get(socket.id)?.name}`,
    });

    // send all the current producer to newly joined member
    const producerList = rooms
      .get(socket.data.roomId)
      ?.getProducerListForPeer();

    socket.emit('newProducers', producerList);
  });

  socket.on('getRouterRtpCapabilities', (_, callback) => {
    console.log('Get RouterRtpCapabilities', {
      name: `${rooms.get(socket.data.roomId)?.getPeers().get(socket.id)?.name}`,
    });

    try {
      callback(rooms.get(socket.data.roomId)?.getRtpCapabilities());
    } catch (e: any) {
      callback({
        error: e.message,
      });
    }
  });

  socket.on('createWebRtcTransport', async (_, callback) => {
    console.log('Create webrtc transport', {
      name: `${rooms.get(socket.data.roomId)?.getPeers().get(socket.id)?.name}`,
    });

    try {
      const transport = await rooms
        .get(socket.data.roomId)
        ?.createWebRtcTransport(socket.id);

      callback(transport?.params);
    } catch (err: any) {
      console.error(err);
      callback({
        error: err.message,
      });
    }
  });

  socket.on(
    'connectTransport',
    async ({ transport_id, dtlsParameters }, callback) => {
      console.log('Connect transport', {
        name: `${
          rooms.get(socket.data.roomId)?.getPeers().get(socket.id)?.name
        }`,
      });

      if (!rooms.has(socket.data.roomId)) return;
      await rooms
        .get(socket.data.roomId)
        ?.connectPeerTransport(socket.id, transport_id, dtlsParameters);

      callback('success');
    },
  );

  socket.on(
    'produce',
    async ({ kind, rtpParameters, producerTransportId }, callback) => {
      if (!rooms.has(socket.data.roomId)) {
        return callback({ error: 'not is a room' });
      }

      const producer_id = await rooms
        .get(socket.data.roomId)
        ?.produce(socket.id, producerTransportId, rtpParameters, kind);

      console.log('Produce', {
        type: `${kind}`,
        name: `${
          rooms.get(socket.data.roomId)?.getPeers().get(socket.id)?.name
        }`,
        id: `${producer_id}`,
      });

      callback({
        producer_id,
      });
    },
  );

  socket.on(
    'consume',
    async ({ consumerTransportId, producerId, rtpCapabilities }, callback) => {
      //TODO null handling
      const params = await rooms
        .get(socket.data.roomId)
        ?.consume(socket.id, consumerTransportId, producerId, rtpCapabilities);

      console.log('Consuming', {
        name: `${
          rooms.get(socket.data.roomId) &&
          rooms.get(socket.data.roomId)?.getPeers().get(socket.id)?.name
        }`,
        producer_id: `${producerId}`,
        consumer_id: `${params?.id}`,
      });

      console.log(params);

      callback(params);
    },
  );

  /*socket.on('resume', async (data, callback) => {
    await consumer.resume();
    callback();
  });*/

  socket.on('getMyRoomInfo', (_, cb) => {
    cb(rooms.get(socket.data.roomId)?.toJson());
  });

  socket.on('disconnect', () => {
    console.log('Disconnect', {
      name: `${
        rooms.get(socket.data.roomId) &&
        rooms.get(socket.data.roomId)?.getPeers().get(socket.id)?.name
      }`,
    });

    if (!socket.data.roomId) return;
    rooms.get(socket.data.roomId)?.removePeer(socket.id);
  });

  socket.on('producerClosed', ({ producer_id }) => {
    console.log('Producer close', {
      name: `${
        rooms.get(socket.data.roomId) &&
        rooms.get(socket.data.roomId)?.getPeers().get(socket.id)?.name
      }`,
    });

    rooms.get(socket.data.roomId)?.closeProducer(socket.id, producer_id);
  });

  socket.on('exitRoom', async (_, callback) => {
    console.log('Exit room', {
      name: `${
        rooms.get(socket.data.roomId) &&
        rooms.get(socket.data.roomId)?.getPeers().get(socket.id)?.name
      }`,
    });

    if (!rooms.has(socket.data.roomId)) {
      callback({
        error: 'not currently in a room',
      });
      return;
    }
    // close transports
    rooms.get(socket.data.roomId)?.removePeer(socket.id);
    if (rooms.get(socket.data.roomId)?.getPeers().size === 0) {
      rooms.delete(socket.data.roomId);
    }

    socket.data.roomId = null;

    callback('successfully exited room');
  });
});
