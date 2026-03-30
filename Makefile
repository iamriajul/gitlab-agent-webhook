APP = glab-review-webhook
PM2 = ./node_modules/.bin/pm2

.PHONY: setup build start stop restart logs logs-err status deploy clean

setup:
	bun install
	@test -f .env || { echo "ERROR: .env file missing. Copy .env.example and fill in values."; exit 1; }

build: setup
	bun run build

start: build
	mkdir -p logs data
	$(PM2) start ecosystem.config.cjs

stop:
	$(PM2) stop $(APP)

restart: build
	$(PM2) restart $(APP)

logs:
	$(PM2) logs $(APP)

logs-err:
	$(PM2) logs $(APP) --err

status:
	$(PM2) status $(APP)

deploy: build
	$(PM2) restart $(APP) || $(PM2) start ecosystem.config.cjs
	$(PM2) save

clean:
	rm -rf dist
