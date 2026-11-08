.PHONY: up down dev bot worker test typecheck lint migrate build route-parity smoke script restore-db

up:
	docker compose up -d --wait

down:
	docker compose down

dev: up
	bun run dev | bunx pino-pretty

bot: up
	bun run dev:bot | bunx pino-pretty

worker: up
	bun run dev:worker | bunx pino-pretty

test: up
	bun run test

typecheck:
	bun run typecheck

lint:
	bun run lint

migrate: up
	bun run db:migrate

build:
	bun run build

route-parity:
	bun run route-parity

smoke: up
	bun run smoke

# make script name=demo_user_stats args='...'
script: up
	bun run script $(name) $(args)

# make restore-db file=<dump>: replaces the local database
restore-db: up
	bun run script restore_database $(file)
