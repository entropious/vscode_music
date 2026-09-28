// Mock Yandex Music API for the test stand: the same server the tests use.
const fs = require('fs');
const path = require('path');
const { MOCK_TOKEN, startMockServer } = require('../out/test/mockServer.js');

const root = path.join(__dirname, '..');
startMockServer(path.join(root, 'test-fixtures/tone.mp3')).then((server) => {
  fs.writeFileSync(path.join(__dirname, 'mock.json'), JSON.stringify({ base: server.base, token: MOCK_TOKEN }));
  console.log(`mock API: ${server.base}`);
});
