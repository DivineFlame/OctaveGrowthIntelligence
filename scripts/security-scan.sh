#!/bin/bash
docker inspect --format '{{.Name}} User={{.Config.User}} ReadOnly={{.HostConfig.ReadonlyRootfs}}' $(docker ps -q)
sudo ufw status
ss -tulpn | grep LISTEN
