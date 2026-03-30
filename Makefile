APP = glab-review-webhook

.PHONY: build start stop restart logs logs-err status deploy clean

build:
	bun run build

start: build
	mkdir -p logs data
	pm2 start ecosystem.config.cjs

stop:
	pm2 stop $(APP)

restart: build
	pm2 restart $(APP)

logs:
	pm2 logs $(APP)

logs-err:
	pm2 logs $(APP) --err

status:
	pm2 status $(APP)

deploy: build
	pm2 restart $(APP) || pm2 start ecosystem.config.cjs
	pm2 save

clean:
	rm -rf dist logs/.pm2*
