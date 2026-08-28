FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    SHIPWITNESS_STORE_FILE=/app/data/store.json

WORKDIR /app
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.js ./
COPY lib ./lib
COPY outputs/shipwitness-prototype ./outputs/shipwitness-prototype
RUN mkdir -p /app/data && chown -R pwuser:pwuser /app

USER pwuser
EXPOSE 4173
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
