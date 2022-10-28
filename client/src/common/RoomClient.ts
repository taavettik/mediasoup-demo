import mediasoupClient, { Device } from 'mediasoup-client';
import { Socket as IoSocket } from 'socket.io-client';

export enum MediaType {
  VIDEO = 'video',
  AUDIO = 'audio',
  SCREEN = 'screen',
}

export class RoomClient {
  consumers: Map<string, mediasoupClient.types.Consumer> = new Map();
  producers: Map<string, mediasoupClient.types.Producer> = new Map();
  producerLabel = new Map<MediaType, string>();

  device: mediasoupClient.Device | null = null;
  producerTransport: mediasoupClient.types.Transport | null = null;
  consumerTransport: mediasoupClient.types.Transport | null = null;

  constructor(
    public readonly roomId: string,
    public readonly name: string,
    private readonly socket: IoSocket,
  ) {
    this.init();
  }

  async init() {
    await this.createRoom(this.roomId);

    await this.join(this.name, this.roomId);

    await this.initSockets();
  }

  async createRoom(roomId: string) {
    try {
      await this.request('createRoom', {
        room_id: roomId,
      });
    } catch (e) {
      console.error(`Create room error`, e);
    }
  }

  async join(name: string, roomId: string) {
    const data = await this.request('join', {
      name,
      room_id: roomId,
    });

    console.log(`>> joined to room`, name, data);
    const rtpData = await this.request('getRouterRtpCapabilities');

    console.log(`>rtp data`, rtpData);

    const device = await this.loadDevice(rtpData);

    this.device = device;

    await this.initTransports(device);

    this.socket.emit('getProducers');
  }

  private async initTransports(device: Device) {
    await this.initProducerTransport(device);
    await this.initConsumerTransport();
  }

  private async initProducerTransport(device: Device) {
    if (!this.device) {
      return;
    }

    const data = await this.request('createWebRtcTransport', {
      forceTcp: false,
      rtpCapabilities: device.rtpCapabilities,
    });

    this.producerTransport = this.device.createSendTransport(data);

    this.producerTransport.on(
      'connect',
      async ({ dtlsParameters }: any, callback, errback) => {
        try {
          console.log('connect', data);

          await this.request('connectTransport', {
            dtlsParameters: dtlsParameters,
            transport_id: data.id,
          });
          callback();
        } catch (e: any) {
          console.error(e);
          errback(e);
        }
      },
    );

    this.producerTransport.on('produce', async (data, callback, errback) => {
      try {
        const { producer_id: producerId } = await this.request('produce', {
          producerTransportId: this.producerTransport?.id,
          kind: data.kind,
          rtpParameters: data.rtpParameters,
        });

        console.log(`>> received producer`, producerId);

        callback({
          id: producerId,
        });
      } catch (e: any) {
        errback(e);
      }
    });

    this.producerTransport.on('connectionstatechange', (state) => {
      console.log(`>> producer transport state`, state);
      if (state === 'failed') {
        this.producerTransport?.close();
      }
    });

    console.log(this.producerTransport);
  }

  private async initConsumerTransport() {
    if (!this.device) {
      return;
    }

    const data = await this.request('createWebRtcTransport', {
      forceTcp: false,
    });

    this.consumerTransport = this.device.createRecvTransport(data);

    this.consumerTransport.on('connect', async (data, callback, errback) => {
      try {
        await this.request('connectTransport', {
          transport_id: this.consumerTransport?.id,
          dtlsParameters: data.dtlsParameters,
        });
        callback();
      } catch (e: any) {
        console.error(e);
        errback(e);
      }
    });

    this.consumerTransport.on('connectionstatechange', (state) => {
      console.log(`>> consumer transport state changed`, state);
      if (state === 'failed') {
        this.consumerTransport?.close();
      }
    });
  }

  private async initSockets() {
    this.socket.on('consumerClosed', () => {
      console.log(`Consumer closed`);
    });

    this.socket.on('newProducers', async (data) => {
      console.log(`New producers`, data);
      for (const { producerId } of data) {
        console.log(producerId);
        await this.consume(producerId);
      }
    });
  }

  async produce(type: MediaType, deviceId?: string) {
    const mediaConstraints = this.getMediaConstraints(type, deviceId);

    if (this.producerLabel.has(type)) {
      console.log(`Producer already exists for this type: ${type}`);
    }

    console.log('Mediaconstraints', mediaConstraints);

    let stream: MediaStream | null = null;
    try {
      if (type === MediaType.SCREEN) {
        stream = await navigator.mediaDevices.getDisplayMedia();
      } else {
        stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
      }
    } catch (e) {
      console.error(`Failed to open media: ${type}`);
    }

    if (!stream) {
      console.error(`Failed to open stream`);
      return;
    }

    console.log(stream);

    const track =
      type === MediaType.AUDIO
        ? stream.getAudioTracks()[0]
        : stream.getVideoTracks()[0];

    console.log(track, type);

    const params =
      type === MediaType.VIDEO
        ? {
            track,
            encodings: [
              {
                rid: 'r0',
                maxBitrate: 100000,
                //scaleResolutionDownBy: 10.0,
                scalabilityMode: 'S1T3',
              },
              {
                rid: 'r1',
                maxBitrate: 300000,
                scalabilityMode: 'S1T3',
              },
              {
                rid: 'r2',
                maxBitrate: 900000,
                scalabilityMode: 'S1T3',
              },
            ],
            codecOptions: {
              videoGoogleStartBitrate: 1000,
            },
          }
        : {
            track,
          };

    console.log(`> producer params`, params);

    const producer = await this.producerTransport?.produce({
      track: params.track,
      encodings: [
        {
          rid: 'r0',
          maxBitrate: 100000,
          //scaleResolutionDownBy: 10.0,
          scalabilityMode: 'S1T3',
        },
        {
          rid: 'r1',
          maxBitrate: 300000,
          scalabilityMode: 'S1T3',
        },
        {
          rid: 'r2',
          maxBitrate: 900000,
          scalabilityMode: 'S1T3',
        },
      ],
      codecOptions: {
        videoGoogleStartBitrate: 1000,
      },
    });

    if (!producer) {
      console.error(`Failed to create producer`);

      return;
    }

    console.log(`>> producer`, producer);

    this.producers.set(producer.id, producer);

    // TEMPORARY, handle this in React
    if (type === MediaType.VIDEO) {
      const elem = document.createElement('video');
      elem.srcObject = stream;
      elem.id = producer.id;
      elem.playsInline = false;
      elem.autoplay = true;
      elem.className = 'vid';
      document.body.appendChild(elem);
    }

    producer.on('trackended', () => {
      console.log('producer closed');
      this.closeProducer(type);
    });

    producer.on('transportclose', () => {
      console.log('producer transport closed');
      const elem = document.getElementById(producer.id) as HTMLVideoElement;
      if (elem) {
        elem.remove();
      }
      this.producers.delete(producer.id);
    });

    this.producerLabel.set(type, producer.id);
  }

  closeProducer(type: MediaType) {
    const producerId = this.producerLabel.get(type);

    if (!producerId) {
      console.log(`There is no producer for this type: ${type}`);
      return;
    }

    this.request('producerClosed', {
      producer_id: producerId,
    });

    this.producers.get(producerId)?.close();
    this.producers.delete(producerId);
    this.producerLabel.delete(type);
  }

  async consume(producerId: string) {
    const stream = await this.getConsumeStream(producerId);

    if (!stream) {
      console.error(`Failed to consume ${producerId}`);
      return;
    }

    this.consumers.set(stream.consumer.id, stream.consumer);

    if (stream.kind === 'video') {
      const elem = document.createElement('video');
      elem.srcObject = stream.stream;
      elem.id = stream.consumer.id;
      elem.playsInline = false;
      elem.autoplay = true;
      elem.className = 'vid';

      document.body.appendChild(elem);
    }

    stream.consumer.on('trackended', () => {
      this.removeConsumer(stream.consumer.id);
    });

    stream.consumer.on('transportclose', () => {
      this.removeConsumer(stream.consumer.id);
    });
  }

  private async getConsumeStream(producerId: string) {
    if (!this.device || !this.consumerTransport) {
      return;
    }

    const { rtpCapabilities } = this.device;

    const data = await this.request('consume', {
      rtpCapabilities,
      consumerTransportId: this.consumerTransport.id,
      producerId,
    });

    const { id, kind, rtpParameters } = data;

    const consumer = await this.consumerTransport.consume({
      id,
      producerId,
      kind,
      rtpParameters,
    });

    const stream = new MediaStream();
    stream.addTrack(consumer.track);

    return {
      consumer,
      stream,
      kind,
    };
  }

  private removeConsumer(consumerId: string) {
    const elem = document.getElementById(consumerId) as HTMLVideoElement;
    elem?.remove();

    this.consumers.delete(consumerId);
  }

  private getMediaConstraints(type: MediaType, deviceId?: string) {
    if (type === MediaType.AUDIO) {
      return {
        audio: {
          deviceId: deviceId,
        },
        video: false,
      };
    } else if (type === MediaType.VIDEO) {
      return {
        audio: false,
        video: {
          width: {
            min: 640,
            ideal: 1920,
          },
          height: {
            min: 400,
            ideal: 1080,
          },
          deviceId: deviceId,
        },
      };
    }
  }

  private async loadDevice(
    routerRtpCapabilities: mediasoupClient.types.RtpCapabilities,
  ) {
    const device = new Device();

    await device.load({
      routerRtpCapabilities,
    });

    return device;
  }

  private request(type: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.socket.emit(type, params, (data: any) => {
        if (data.error) {
          reject(data.error);
        } else {
          resolve(data);
        }
      });
    });
  }
}
