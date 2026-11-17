#!/bin/bash

# Check if host is provided as a command line argument
if [ -z "$1" ]; then
  echo "Usage: $0 <host>"
  echo "Example: $0 http://localhost:3000"
  exit 1
fi
host=${1%/}

for command in curl jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done

# Check the database-backed route before starting any background traffic.
echo "Checking backend: $host"
if ! menu_response=$(curl -sS --connect-timeout 5 --max-time 20 -w '\n%{http_code}' "$host/api/order/menu"); then
  echo "Cannot reach the backend. Traffic was not started." >&2
  exit 1
fi
menu_status=${menu_response##*$'\n'}
menu_body=${menu_response%$'\n'*}
if [[ "$menu_status" != "200" ]] || ! jq -e 'type == "array"' <<< "$menu_body" >/dev/null 2>&1; then
  menu_error=$(jq -r '.message // "Expected a JSON menu from the backend API"' <<< "$menu_body" 2>/dev/null) || menu_error="Expected a JSON menu from the backend API"
  echo "Backend menu failed (HTTP $menu_status): $menu_error" >&2
  echo "Fix the backend connection before generating traffic." >&2
  exit 1
fi

# Trap SIGINT (Ctrl+C) to execute the cleanup function
cleanup() {
  echo "Terminating background processes..."
  kill "$pid1" "$pid2" "$pid3" "$pid4" "$pid5" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM

# Wrap curl command to return HTTP response codes
execute_curl() {
  curl -sS --connect-timeout 5 --max-time 120 -o /dev/null -w '%{http_code}' "$@"
}

# Function to login and get a token
login() {
  local response token message
  response=$(curl -sS --connect-timeout 5 --max-time 20 -X PUT "$host/api/auth" -d "{\"email\":\"$1\", \"password\":\"$2\"}" -H 'Content-Type: application/json') || return 1
  if ! token=$(jq -er '.token | select(type == "string" and length > 0)' <<< "$response" 2>/dev/null); then
    message=$(jq -r '.message // "No authentication token returned"' <<< "$response" 2>/dev/null) || message="Invalid backend response"
    echo "Login failed for $1: $message" >&2
    return 1
  fi
  printf '%s\n' "$token"
}

# Simulate a user requesting the menu every 3 seconds
while true; do
  result=$(execute_curl "$host/api/order/menu")
  echo "Requesting menu..." $result
  sleep 3
done &
pid1=$!

# Simulate a user with an invalid email and password every 25 seconds
while true; do
  result=$(execute_curl -X PUT "$host/api/auth" -d '{"email":"unknown@jwt.com", "password":"bad"}' -H 'Content-Type: application/json')
  echo "Logging in with invalid credentials..." $result
  sleep 25
done &
pid2=$!

# Simulate a franchisee logging in every two minutes
while true; do
  if ! token=$(login "f@jwt.com" "franchisee"); then
    echo "Login franchisee... false"
    sleep 10
    continue
  fi
  echo "Login franchisee... true"
  sleep 110
  result=$(execute_curl -X DELETE "$host/api/auth" -H "Authorization: Bearer $token")
  echo "Logging out franchisee..." $result
  sleep 10
done &
pid3=$!

# Simulate a diner ordering a pizza every 50 seconds
while true; do
  if ! token=$(login "d@jwt.com" "diner"); then
    echo "Login diner... false"
    sleep 10
    continue
  fi
  echo "Login diner... true"
  result=$(execute_curl -X POST "$host/api/order" -H 'Content-Type: application/json' -d '{"franchiseId": 1, "storeId":1, "items":[{ "menuId": 1, "description": "Veggie", "price": 0.05 }]}' -H "Authorization: Bearer $token")
  echo "Bought a pizza..." $result
  sleep 20
  result=$(execute_curl -X DELETE "$host/api/auth" -H "Authorization: Bearer $token")
  echo "Logging out diner..." $result
  sleep 30
done &
pid4=$!

# Simulate a failed pizza order every 5 minutes
while true; do
  if ! token=$(login "d@jwt.com" "diner"); then
    echo "Login hungry diner... false"
    sleep 10
    continue
  fi
  echo "Login hungry diner... true"

  items='{ "menuId": 1, "description": "Veggie", "price": 0.05 }'
  for (( i=0; i < 21; i++ ))
  do items+=', { "menuId": 1, "description": "Veggie", "price": 0.05 }'
  done
  
  result=$(execute_curl -X POST "$host/api/order" -H 'Content-Type: application/json' -d "{\"franchiseId\": 1, \"storeId\":1, \"items\":[$items]}" -H "Authorization: Bearer $token")
  echo "Bought too many pizzas..." $result  
  sleep 5
  result=$(execute_curl -X DELETE "$host/api/auth" -H "Authorization: Bearer $token")
  echo "Logging out hungry diner..." $result
  sleep 295
done &
pid5=$!


# Wait for the background processes to complete
wait $pid1 $pid2 $pid3 $pid4 $pid5
