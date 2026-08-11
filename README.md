# WhatsNotify

WhatsNotify encaminha alertas do WhatsApp, executa automações agendadas e expõe um dashboard administrativo. O deploy oficial usa Git + systemd.

## Instalação / migração em um comando

No Ubuntu/Debian, execute como root:

```bash
curl -fsSL https://raw.githubusercontent.com/Olivar/WhatsNotify/main/whatsnotify.sh -o /tmp/whatsnotify.sh && chmod +x /tmp/whatsnotify.sh && /tmp/whatsnotify.sh install
```

Não use `bash <(curl ...)`: process substitution expõe o script via `/dev/fd`/`/proc/.../fd` e impede a autodetecção confiável do diretório do bootstrap.

O mesmo comando detecta automaticamente uma instalação legada em `/opt/whatsapp-forwarder` e migra:

- `/etc/default/whatsapp-forwarder` para `/etc/whatsnotify/whatsnotify.env`;
- sessão `.wwebjs_auth` para `/var/lib/whatsnotify/sessions`;
- cache WhatsApp Web para `/var/lib/whatsnotify/web-cache`;
- cache Puppeteer para `/var/lib/whatsnotify/puppeteer-cache`;
- serviço antigo `whatsapp-forwarder.service` para `whatsnotify.service` somente após health check bem-sucedido.

O instalador também:

- instala Git, curl, Python, util-linux e bibliotecas do Chromium;
- instala Node.js 24 se Node.js >=18 não existir;
- clona o repositório em `/opt/WhatsNotify`;
- cria usuário de serviço e diretórios persistentes;
- preserva configurações existentes;
- gera senha administrativa inicial quando necessário;
- instala dependências npm/Puppeteer;
- instala e habilita units systemd;
- ativa auto-update;
- valida `/api/health`;
- reativa automaticamente o serviço legado se a migração falhar.

## Operação

Toda administração usa o mesmo script:

```bash
cd /opt/WhatsNotify

./whatsnotify.sh status
./whatsnotify.sh check
./whatsnotify.sh update
./whatsnotify.sh rollback
./whatsnotify.sh repair
```

`install.sh` e `update.sh` existem apenas como wrappers de compatibilidade; a lógica operacional está integralmente em `whatsnotify.sh`.

## Atualização automática

O `systemd` executa:

```text
/opt/WhatsNotify/whatsnotify.sh auto
```

Configuração:

```env
AUTO_UPDATE_ENABLED=true
AUTO_UPDATE_INTERVAL=300
AUTO_UPDATE_BRANCH=main
AUTO_UPDATE_REMOTE=origin
```

Fluxo de update:

```text
lock
> valida working tree
> git fetch
> valida fast-forward
> registra commit anterior
> aplica origin/main
> npm ci/install
> reaplica systemd
> executa scripts/upgrade.sh
> reinicia serviço
> health check
> confirma atualização
```

Se qualquer etapa falhar após a troca de commit:

```text
rollback para previousCommit
> restaura dependências
> reaplica systemd
> reinicia serviço
> registra rolled_back
```

## Persistência

| Tipo | Local |
|---|---|
| Código Git | `/opt/WhatsNotify` |
| Configuração | `/etc/whatsnotify/whatsnotify.env` |
| Sessão WhatsApp | `/var/lib/whatsnotify/sessions` |
| Web cache | `/var/lib/whatsnotify/web-cache` |
| Cache Puppeteer | `/var/lib/whatsnotify/puppeteer-cache` |
| Estado de update | `/var/lib/whatsnotify/update-state.json` |
| Log de update | `/var/log/whatsnotify/update.log` |
| Runtime logs | journald |

## Serviço

```bash
systemctl status whatsnotify
systemctl restart whatsnotify
journalctl -u whatsnotify -f
```

## Dashboard

Por padrão o dashboard escuta em `127.0.0.1:8080` e usa Basic Auth.

```bash
ssh -L 8080:127.0.0.1:8080 servidor
```

Health check local:

```bash
curl -fsS http://127.0.0.1:8080/api/health
```

A ação de atualização pelo dashboard somente funciona quando `DASHBOARD_ALLOW_UPDATE=true` e inicia exclusivamente `whatsnotify-update-manual.service`.

## NTP

O app monitora `a.ntp.br,b.ntp.br,c.ntp.br` e não altera diretamente o relógio. Em LXC, a sincronização real deve permanecer no host Proxmox/chrony; não conceda `CAP_SYS_TIME` ao container.

## Testes

```bash
npm test
```

## Segurança

- Configuração, sessão e caches ficam fora do Git.
- Updater rejeita worktree rastreada suja e atualização não-fast-forward.
- Update usa lock exclusivo.
- Falhas após troca de versão acionam rollback.
- Repositório público não exige token para clone/fetch.
- Dashboard deve permanecer em localhost ou atrás de TLS.
