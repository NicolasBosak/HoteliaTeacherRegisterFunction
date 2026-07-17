jest.mock('@azure/functions', () => ({
    app: {
        setup: jest.fn()
    }
}));

const { app } = require('@azure/functions');

describe('Azure Functions application setup', () => {
    beforeAll(() => {
        require('../../src/index');
    });

    it('enables HTTP streaming', () => {
        expect(app.setup).toHaveBeenCalledWith({
            enableHttpStream: true
        });
    });
});
