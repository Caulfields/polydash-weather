const { Readable } = require('stream');

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function errorResponse(message, status = 500) {
  return {
    ok: false,
    status,
    json: async () => ({ error: message }),
    text: async () => message,
  };
}

function makePlainRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    end(data) {
      res.body = data == null ? '' : String(data);
      res.ended = true;
      return res;
    },
    json(data) {
      res.body = JSON.stringify(data);
      res.ended = true;
      return res;
    },
  };
  return res;
}

function makePlainReq(overrides = {}) {
  const req = {
    method: 'GET',
    query: {},
    headers: {},
    body: undefined,
    ...overrides,
  };
  return req;
}

function fakeHttpsResponse(body, statusCode = 200) {
  const res = new Readable({ read() {} });
  res.statusCode = statusCode;
  process.nextTick(() => {
    res.push(Buffer.from(body));
    res.push(null);
  });
  return res;
}

function mockHttpsGet(t, { byUrl, defaultStatus = 200 }) {
  const original = require('https').get;
  t.mock.method(require('https'), 'get', (url, opts, callback) => {
    const entry = byUrl(url);
    const body = entry ? entry.body : '{}';
    const status = entry && typeof entry.status === 'number' ? entry.status : defaultStatus;
    const res = fakeHttpsResponse(typeof body === 'string' ? body : JSON.stringify(body), status);
    callback(res);
    return { on: () => undefined, once: () => undefined, emit: () => undefined };
  });
  return original;
}

module.exports = {
  jsonResponse,
  errorResponse,
  makePlainRes,
  makePlainReq,
  fakeHttpsResponse,
  mockHttpsGet,
};