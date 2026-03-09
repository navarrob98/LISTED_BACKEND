jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
}));

const Sentry = require('@sentry/node');
const initSockets = require('../../sockets/index');

describe('Socket.io initSockets', () => {
  let mockIo, mockSocket, mockPool, mockHelpers;
  let connectionHandler;
  let socketHandlers;
  let mockPromiseQuery;

  beforeEach(() => {
    jest.clearAllMocks();
    socketHandlers = {};

    mockSocket = {
      id: 'socket-123',
      data: { userId: 1 },
      join: jest.fn(),
      on: jest.fn((event, handler) => {
        socketHandlers[event] = handler;
      }),
    };

    mockIo = {
      on: jest.fn((event, handler) => {
        if (event === 'connection') connectionHandler = handler;
      }),
      to: jest.fn(() => ({ emit: jest.fn() })),
    };

    mockPromiseQuery = jest.fn();
    mockPool = {
      query: jest.fn(),
      promise: jest.fn(() => ({ query: mockPromiseQuery })),
    };

    mockHelpers = {
      sendPushToUser: jest.fn().mockResolvedValue(true),
      buildDeliveryUrlFromSecure: jest.fn((url) => url + '?signed'),
      isMutedForReceiver: jest.fn().mockResolvedValue(false),
    };

    initSockets(mockIo, mockPool, mockHelpers);
    connectionHandler(mockSocket);
  });

  it('should join user room on connection', () => {
    expect(mockSocket.join).toHaveBeenCalledWith('user_1');
  });

  it('should register event handlers', () => {
    expect(socketHandlers['disconnect']).toBeDefined();
    expect(socketHandlers['error']).toBeDefined();
    expect(socketHandlers['send_message']).toBeDefined();
    expect(socketHandlers['delete_message']).toBeDefined();
  });

  describe('disconnect', () => {
    it('should handle disconnect without error', () => {
      expect(() => socketHandlers['disconnect']('client disconnect')).not.toThrow();
    });
  });

  describe('error', () => {
    it('should capture error with Sentry', () => {
      const err = new Error('socket error');
      socketHandlers['error'](err);
      expect(Sentry.captureException).toHaveBeenCalledWith(err, { tags: { socket_event: 'error' } });
    });
  });

  describe('send_message', () => {
    it('should do nothing if no receiver_id', () => {
      socketHandlers['send_message']({ message: 'hello' });
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('should do nothing if text message with no content', () => {
      socketHandlers['send_message']({ receiver_id: 2 });
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('should do nothing for property_card without shared_property_id', () => {
      socketHandlers['send_message']({ receiver_id: 2, message_type: 'property_card' });
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('should insert text message and emit', async () => {
      const emitFn = jest.fn();
      mockIo.to.mockReturnValue({ emit: emitFn });

      mockPool.query
        .mockImplementationOnce((sql, vals, cb) => cb(null, { insertId: 100 })) // insert
        .mockImplementationOnce((sql, vals, cb) => cb(null)); // hidden_chats delete

      socketHandlers['send_message']({
        receiver_id: 2,
        property_id: 10,
        message: 'Hello!',
      });

      // Wait for async operations
      await new Promise(r => setTimeout(r, 50));

      expect(mockPool.query).toHaveBeenCalled();
      expect(mockIo.to).toHaveBeenCalledWith('user_1');
      expect(mockIo.to).toHaveBeenCalledWith('user_2');
      expect(mockHelpers.sendPushToUser).toHaveBeenCalled();
    });

    it('should handle file message with signed URL', async () => {
      const emitFn = jest.fn();
      mockIo.to.mockReturnValue({ emit: emitFn });

      mockPool.query
        .mockImplementationOnce((sql, vals, cb) => cb(null, { insertId: 101 }))
        .mockImplementationOnce((sql, vals, cb) => cb(null));

      socketHandlers['send_message']({
        receiver_id: 2,
        file_url: 'https://res.cloudinary.com/file.pdf',
        file_name: 'doc.pdf',
      });

      await new Promise(r => setTimeout(r, 50));

      expect(mockHelpers.buildDeliveryUrlFromSecure).toHaveBeenCalled();
    });

    it('should skip push if muted', async () => {
      const emitFn = jest.fn();
      mockIo.to.mockReturnValue({ emit: emitFn });
      mockHelpers.isMutedForReceiver.mockResolvedValue(true);

      mockPool.query
        .mockImplementationOnce((sql, vals, cb) => cb(null, { insertId: 102 }))
        .mockImplementationOnce((sql, vals, cb) => cb(null));

      socketHandlers['send_message']({
        receiver_id: 2,
        message: 'Hello',
      });

      await new Promise(r => setTimeout(r, 50));

      expect(mockHelpers.sendPushToUser).not.toHaveBeenCalled();
    });

    it('should handle property_card message type', async () => {
      const emitFn = jest.fn();
      mockIo.to.mockReturnValue({ emit: emitFn });

      mockPool.query
        .mockImplementationOnce((sql, vals, cb) => cb(null, { insertId: 103 }))
        .mockImplementationOnce((sql, vals, cb) => cb(null)); // hidden_chats

      mockPromiseQuery.mockResolvedValueOnce([[{
        id: 5, address: 'Test', type: 'venta', price: 100,
        monthly_pay: null, estate_type: 'casa', first_image: 'img.jpg',
      }]]);

      socketHandlers['send_message']({
        receiver_id: 2,
        message_type: 'property_card',
        shared_property_id: 5,
      });

      await new Promise(r => setTimeout(r, 50));

      expect(mockPromiseQuery).toHaveBeenCalled();
    });

    it('should handle appointment_card message type', async () => {
      const emitFn = jest.fn();
      mockIo.to.mockReturnValue({ emit: emitFn });

      mockPool.query
        .mockImplementationOnce((sql, vals, cb) => cb(null, { insertId: 104 }))
        .mockImplementationOnce((sql, vals, cb) => cb(null));

      mockPromiseQuery.mockResolvedValueOnce([[{
        id: 7, appointment_date: '2030-01-01', appointment_time: '10:00',
        status: 'confirmed', property_address: 'Test', requester_id: 2, agent_id: 1,
      }]]);

      socketHandlers['send_message']({
        receiver_id: 2,
        message_type: 'appointment_card',
        shared_property_id: 7,
      });

      await new Promise(r => setTimeout(r, 50));

      expect(mockPromiseQuery).toHaveBeenCalled();
    });

    it('should handle INSERT error', async () => {
      mockPool.query.mockImplementationOnce((sql, vals, cb) => cb(new Error('insert fail')));

      socketHandlers['send_message']({
        receiver_id: 2,
        message: 'Hello',
      });

      await new Promise(r => setTimeout(r, 50));

      expect(Sentry.captureException).toHaveBeenCalled();
      expect(mockIo.to).not.toHaveBeenCalledWith('user_2');
    });
  });

  describe('delete_message', () => {
    it('should do nothing if no message_id', () => {
      socketHandlers['delete_message']({});
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('should delete message and emit to both users', async () => {
      const emitFn = jest.fn();
      mockIo.to.mockReturnValue({ emit: emitFn });

      mockPool.query
        .mockImplementationOnce((sql, params, cb) => cb(null, [{ sender_id: 1, receiver_id: 2, property_id: 10 }]))
        .mockImplementationOnce((sql, params, cb) => cb(null));

      socketHandlers['delete_message']({ message_id: 50 });

      expect(mockPool.query).toHaveBeenCalled();
      expect(mockIo.to).toHaveBeenCalledWith('user_1');
      expect(mockIo.to).toHaveBeenCalledWith('user_2');
    });

    it('should not delete if user is not participant', () => {
      mockSocket.data.userId = 999;
      // Re-register handlers with new userId
      socketHandlers = {};
      mockSocket.on = jest.fn((event, handler) => {
        socketHandlers[event] = handler;
      });
      connectionHandler(mockSocket);

      mockPool.query.mockImplementationOnce((sql, params, cb) =>
        cb(null, [{ sender_id: 1, receiver_id: 2, property_id: 10 }])
      );

      socketHandlers['delete_message']({ message_id: 50 });

      // Only the SELECT query should have been called, not the UPDATE
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });

    it('should handle SELECT error gracefully', () => {
      mockPool.query.mockImplementationOnce((sql, params, cb) => cb(new Error('fail')));
      socketHandlers['delete_message']({ message_id: 50 });
      // Should not throw
    });

    it('should handle no rows found', () => {
      mockPool.query.mockImplementationOnce((sql, params, cb) => cb(null, []));
      socketHandlers['delete_message']({ message_id: 50 });
      // Should not proceed to UPDATE
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });
  });
});
