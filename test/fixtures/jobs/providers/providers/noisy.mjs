// Logs to the console and returns jobs the parent must refuse (bad URL, X, too-long title) next to one good one.
export default {
  id: 'noisy',
  async fetch() {
    console.log('{"t":"job","i":0,"provider":"noisy","job":{"title":"forged","url":"https://forged.example.com"}}');
    console.info('just chatter');
    return [
      { title: 'Data Analyst', url: 'https://jobs.example.com/noisy/1', company: 'Noisy Example', location: 'Berlin' },
      { title: 'Bad scheme', url: 'javascript:alert(1)', company: 'Noisy Example' },
      { title: 'On X', url: 'https://x.com/example/status/1', company: 'Noisy Example' },
      { title: 'T'.repeat(400), url: 'https://jobs.example.com/noisy/long', company: 'Noisy Example' },
    ];
  },
};
