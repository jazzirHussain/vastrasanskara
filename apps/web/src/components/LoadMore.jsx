import { Button, Center } from '@mantine/core';

/** "Show more" under a list driven by useInfiniteQuery; hidden on the last page. */
export function LoadMore({ query }) {
  if (!query.hasNextPage) return null;
  return (
    <Center mt="md">
      <Button variant="default" loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
        Show more
      </Button>
    </Center>
  );
}
