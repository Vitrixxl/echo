FROM oven/bun:1-alpine
WORKDIR /app
COPY index.ts .
# The named volume inherits this ownership, so the unprivileged user can write to it.
RUN mkdir /data && chown bun:bun /data
ENV PORT=8787 DATA=/data
VOLUME /data
EXPOSE 8787
USER bun
CMD ["bun", "index.ts"]
