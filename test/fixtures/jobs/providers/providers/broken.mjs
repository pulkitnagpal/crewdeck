export default { id: 'broken', async fetch() { throw new Error('the board is down'); } };
