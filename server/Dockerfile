# Static musl binary in an empty image: the container is the server and nothing else (~4 MB of RAM).
FROM rust:1-alpine AS build
WORKDIR /src
# Dependencies first, in their own layer, so code changes don't recompile them on the Pi.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && touch page.html tracts.pdf && cargo build --release && rm -rf src
COPY src src
COPY page.html tracts.pdf ./
RUN touch src/main.rs && cargo build --release

FROM scratch
COPY --from=build /src/target/release/brancard-server /server
ENV PORT=8787 DATA=/data
# Same uid as the previous (bun) image, so it keeps write access to the existing data volume.
USER 1000:1000
EXPOSE 8787
VOLUME /data
ENTRYPOINT ["/server"]
