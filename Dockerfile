FROM node:20-bullseye
RUN apt-get update && apt-get install -y git cmake g++ libz-dev ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth=1 https://github.com/lightvector/KataGo.git
WORKDIR /build/KataGo/cpp
RUN cmake . -DUSE_BACKEND=CPU_ONLY -DCMAKE_BUILD_TYPE=Release && make -j\

WORKDIR /app
COPY . .
RUN mkdir -p /app/engines/bin && cp /build/KataGo/cpp/katago /app/engines/bin/katago && chmod +x /app/engines/bin/katago

ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node","server.js"]
