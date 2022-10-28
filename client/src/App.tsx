import { useState } from 'react';
import io from 'socket.io-client';
import { MediaType, RoomClient } from './common/RoomClient';

const socket = io('http://localhost:3016');

const deviceId =
  '0af446235e11d793fe3a22c802c7688b18cd9772920e00fbc46d74d8e9e93703';

navigator.mediaDevices.getUserMedia({
  audio: true,
  video: true,
});

const rc = new RoomClient(
  '123',
  'tester' + Math.floor(Math.random() * 1000),
  socket,
);

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="App">
      <div></div>
      <h1>Vite + React</h1>
      <div className="card">
        <button onClick={() => rc.produce('video' as any, deviceId)}>
          Open video
        </button>
        <button onClick={() => rc.closeProducer(MediaType.VIDEO)}>
          Close video
        </button>
        <p>
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
      </div>
      <p className="read-the-docs">
        Click on the Vite and React logos to learn more
      </p>
    </div>
  );
}

export default App;
