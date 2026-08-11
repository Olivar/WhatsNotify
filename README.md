# WhatsNotify

WhatsNotify encaminha alertas do WhatsApp, executa automações agendadas e expõe um dashboard administrativo. O deploy oficial usa Git e `systemd`.

## Repositório oficial

```text
https://github.com/Olivar/WhatsNotify
branch: main
```

## Instalação

Pré-requisitos: Linux com `systemd`, Git, Node.js >= 18, npm e dependências do Puppeteer/Chromium.

```bash
sudo -i
cd /opt
git clone https://github.com/Olivar/WhatsNotify.git WhatsNotify
cd WhatsNotify
./install.sh
nano /etc/whatsnotify/whatsnotify.env
systemctl restart whatsnotify
journalctl -u whatsnotify -f
```

O instalador é idempotente e preserva `/etc/whatsnotify/whatsnotify.env` e `/var/lib/whatsnotify`.

## Persistência

| Tipo | Local |
|---|---|
| Código Git | `/opt/WhatsNotify` |
| Configuração | `/etc/whatsnotify/whatsnotify.env` |
| Sessão WhatsApp | `/var/lib/whatsnotify/sessions` |
| Web cache | `/var/lib/whatsnotify/web-cache` |
| Estado de update | `/var/lib/whatsnotify/update-state.json` |
| Log de update | `/var/log/whatsnotify/update.log` |
| Runtime logs | journald |

## Serviço

```bash
systemctl status whatsnotify
systemctl start whatsnotify
systemctl stop whatsnotify
systemctl restart whatsnotify
journalctl -u whatsnotify -f
```

## Atualização

```bash
cd /opt/WhatsNotify
./update.sh --check
./update.sh
```

Fluxo: lock > valida worktree > fetch > valida fast-forward > registra SHA anterior > aplica `origin/main` > dependências > `scripts/upgrade.sh` > restart > `/api/health` > confirma. Falha aciona rollback para o SHA anterior.

### Auto-update

```env
AUTO_UPDATE_ENABLED=true
AUTO_UPDATE_INTERVAL=300
AUTO_UPDATE_BRANCH=main
AUTO_UPDATE_REMOTE=origin
```

O timer acorda a cada minuto e `update.sh --auto` respeita `AUTO_UPDATE_INTERVAL`.

```bash
systemctl status whatsnotify-update.timer
systemctl list-timers whatsnotify-update.timer
```

Desabilitar:

```bash
sed -i 's/^AUTO_UPDATE_ENABLED=.*/AUTO_UPDATE_ENABLED=false/' /etc/whatsnotify/whatsnotify.env
systemctl disable --now whatsnotify-update.timer
```

Habilitar:

```bash
sed -i 's/^AUTO_UPDATE_ENABLED=.*/AUTO_UPDATE_ENABLED=true/' /etc/whatsnotify/whatsnotify.env
systemctl enable --now whatsnotify-update.timer
```

## Dashboard

Por padrão: `127.0.0.1:8080`, protegido por Basic Auth.

```bash
ssh -L 8080:127.0.0.1:8080 servidor
```

Health check local:

```bash
curl -fsS http://127.0.0.1:8080/api/health
```

A ação **Atualizar agora** somente é habilitada com `DASHBOARD_ALLOW_UPDATE=true`; ela inicia exclusivamente a unidade fixa `whatsnotify-update-manual.service`.

## NTP

O app mede offset contra `a.ntp.br,b.ntp.br,c.ntp.br`, mas não altera o relógio. Em LXC, sincronize o host Proxmox via chrony; não conceda `CAP_SYS_TIME` ao container.

## Testes

```bash
npm test
```

## Segurança

- `.env`, sessões, caches e dados persistentes ficam fora do Git.
- O updater rejeita worktree rastreada suja e update não-fast-forward.
- O repositório público não exige token para clone/fetch.
- O dashboard deve permanecer em localhost ou atrás de TLS.
