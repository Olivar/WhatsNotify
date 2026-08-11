# WhatsNotify

WhatsNotify encaminha alertas do WhatsApp, executa automações agendadas e expõe um dashboard administrativo. O deploy oficial usa Git + systemd.

## Instalação / migração em um comando

No Ubuntu/Debian, execute como root:

```bash
curl -fsSL https://raw.githubusercontent.com/Olivar/WhatsNotify/main/bootstrap.sh -o /tmp/whatsnotify-bootstrap.sh \
  && bash /tmp/whatsnotify-bootstrap.sh install
```

O `bootstrap.sh` existe apenas para garantir um início robusto: instala Git quando necessário, clona/atualiza `/opt/WhatsNotify` e transfere a execução via `bash` para o script principal. Assim, a instalação não depende do bit executável do arquivo recém-clonado e não usa `/dev/fd`/process substitution.

Não use `bash <(curl ...)`.

O instalador principal detecta automaticamente uma instalação legada em `/opt/whatsapp-forwarder` e migra:

- `/etc/default/whatsapp-forwarder` para `/etc/whatsnotify/whatsnotify.env`;
- sessão `.wwebjs_auth` para `/var/lib/whatsnotify/sessions`;
- cache WhatsApp Web para `/var/lib/whatsnotify/web-cache`;
- cache Puppeteer para `/var/lib/whatsnotify/puppeteer-cache`;
- serviço antigo `whatsapp-forwarder.service` para `whatsnotify.service` somente após health check bem-sucedido.

O instalador também:

- instala Git, curl, Python, util-linux e bibliotecas necessárias ao Chromium;
- instala Node.js 24 se Node.js >=18 não existir;
- cria usuário de serviço e diretórios persistentes;
- preserva configurações existentes;
- gera senha administrativa inicial quando necessário;
- instala dependências npm/Puppeteer;
- instala e habilita units systemd;
- ativa auto-update;
- valida `/api/health`;
- reativa automaticamente o serviço legado se uma migração falhar.

### Configuração obrigatória em instalação limpa

Após a primeira criação de `/etc/whatsnotify/whatsnotify.env`, configure pelo menos:

```env
SOURCE_CHAT_ID=271502834421837@lid
TARGET_GROUP_ID=555181570245-1449825290@g.us
SOAP_CRON="0 7 * * *"
```

A senha do dashboard é gerada automaticamente se ainda estiver com o valor padrão.

Depois execute novamente:

```bash
bash /opt/WhatsNotify/whatsnotify.sh install
```

## Runtime validado

A combinação validada em produção é:

```text
Node.js:          24.x
whatsapp-web.js:  1.34.7
Puppeteer:        24.38.0
Chrome:           146.0.7680.31
```

`puppeteer` e `whatsapp-web.js` ficam fixados no `package.json` para evitar alteração silenciosa do navegador em uma nova instalação.

## Operação

Toda administração usa o mesmo script principal:

```bash
cd /opt/WhatsNotify

bash ./whatsnotify.sh status
bash ./whatsnotify.sh check
bash ./whatsnotify.sh update
bash ./whatsnotify.sh rollback
bash ./whatsnotify.sh repair
```

`install.sh` e `update.sh` existem apenas como wrappers de compatibilidade; a lógica operacional está em `whatsnotify.sh`.

### Serviço

```bash
systemctl status whatsnotify --no-pager
systemctl restart whatsnotify
journalctl -u whatsnotify -f -o cat
```

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

Verificação manual:

```bash
cd /opt/WhatsNotify
bash ./whatsnotify.sh check
```

Atualização manual:

```bash
bash ./whatsnotify.sh update
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

## Dashboard

Por padrão o dashboard escuta somente em:

```env
DASHBOARD_BIND=127.0.0.1
DASHBOARD_PORT=8080
```

Acesso local:

```text
http://127.0.0.1:8080/
```

Para acesso via LAN, altere conscientemente para:

```env
DASHBOARD_BIND=0.0.0.0
```

E reinicie:

```bash
systemctl restart whatsnotify
```

Depois acesse:

```text
http://IP_DO_CONTAINER:8080/
```

As credenciais ficam em `/etc/whatsnotify/whatsnotify.env`:

```env
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=...
```

Health check local:

```bash
curl -fsS http://127.0.0.1:8080/api/health
```

A ação de atualização pelo dashboard somente funciona quando `DASHBOARD_ALLOW_UPDATE=true` e inicia exclusivamente `whatsnotify-update-manual.service`.

Para redes não confiáveis, mantenha o dashboard em localhost ou publique-o atrás de HTTPS/HAProxy/Nginx; Basic Auth sobre HTTP não deve ser exposto à Internet.

## WhatsApp Web cache

O runtime usa cache local. Quando não existe uma versão ativa armazenada, permite um bootstrap com a versão atual do WhatsApp Web, persiste o HTML localmente e passa a reutilizar essa versão nos próximos boots.

O objetivo é remover dependência de arquivos externos de cache durante o runtime normal.

## NTP

O app monitora `a.ntp.br,b.ntp.br,c.ntp.br` e não altera diretamente o relógio. Em LXC, a sincronização real deve permanecer no host Proxmox/chrony; não conceda `CAP_SYS_TIME` ao container.

## Testes

```bash
cd /opt/WhatsNotify
npm test
```

## Segurança

- Configuração, sessão e caches ficam fora do Git.
- Updater rejeita working tree rastreada suja e atualização não-fast-forward.
- Update usa lock exclusivo.
- Falhas após troca de versão acionam rollback.
- Repositório público não exige token para clone/fetch.
- Dashboard deve permanecer em localhost ou atrás de TLS quando possível.
