// Never answers: the entry times out.
export default { id: 'slow', fetch: () => new Promise(() => {}) };
