// Local development: all three services in one Express process (npm run dev, port 3000).
const { createApp, finish } = require('./shared/http');
const app = createApp('dev-all');
require('./services/election/routes')(app);
require('./services/voting/routes')(app);
require('./services/results/routes')(app);
finish(app);

const port = process.env.PORT || 3000;
if (require.main === module) app.listen(port, () => console.log(`API on http://localhost:${port}`));
module.exports = app;
