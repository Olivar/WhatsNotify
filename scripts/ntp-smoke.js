'use strict';
const { queryNtp } = require('../lib/ntp-monitor');
(async()=>{
  for (const server of String(process.env.NTP_SERVERS||'a.ntp.br,b.ntp.br,c.ntp.br').split(',')) {
    try { console.log(server, await queryNtp(server.trim(), 3000)); return; }
    catch (e) { console.error(server, e.message); }
  }
  process.exit(1);
})();
